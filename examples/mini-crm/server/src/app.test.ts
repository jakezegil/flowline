import type { Logger, RunDetail, RunSummary } from "@flowkit/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMiniCrm, type MiniCrm, TENANT_ID } from "./app";
import type { Approval, Contact, OutboxMessage } from "./crm-store";
import { demoFlows } from "./flows";

let now: number;
let crm: MiniCrm;
const errors: unknown[] = [];

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error: (message, data) => errors.push({ message, data }),
};

beforeEach(async () => {
  now = Date.UTC(2026, 0, 5, 9, 0);
  errors.length = 0;
  crm = await createMiniCrm({ clock: () => now, publicUrl: "http://crm.test", logger });
});

afterEach(() => {
  expect(errors).toEqual([]);
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return crm.app.request(path, init);
}

async function get<T>(path: string): Promise<T> {
  const res = await call("GET", path);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

async function runDetail(runId: string): Promise<RunDetail> {
  return get<RunDetail>(`/flowkit/runs/${runId}`);
}

async function runsOf(workflowId: string): Promise<RunSummary[]> {
  return get<RunSummary[]>(`/flowkit/runs?workflowId=${workflowId}`);
}

async function webhookPath(): Promise<string> {
  const demo = await get<{ webhooks: Record<string, string> }>("/api/demo");
  const path = demo.webhooks["inbound-lead-routing"];
  expect(path).toMatch(/^\/flowkit\/hooks\/acme\/inbound-lead-routing\/[A-Za-z0-9_-]{16,}$/);
  return path as string;
}

const enterpriseLead = {
  email: "hank@globex.test",
  firstName: "Hank",
  lastName: "Scorpio",
  company: "Globex",
  source: "referral",
  employees: 1200,
};

/** Posts an inbound lead and runs the engine until the run parks or finishes. */
async function postLead(lead: object, requestId: string): Promise<string> {
  const res = await call("POST", await webhookPath(), lead, { "X-Request-Id": requestId });
  expect(res.status).toBe(202);
  const { runId } = (await res.json()) as { runId: string };
  await crm.engine.drain();
  return runId;
}

describe("demo workflows", () => {
  it("all validate without issues", async () => {
    for (const doc of demoFlows) {
      expect(await crm.engine.validate(TENANT_ID, doc), doc.id).toEqual([]);
    }
  });
});

describe("inbound lead routing", () => {
  it("parks an enterprise lead at an approval; approving emails the owner", async () => {
    const runId = await postLead(enterpriseLead, "lead-1");
    expect((await runDetail(runId)).run.status).toBe("waiting");

    const contact = (await get<Contact[]>("/api/contacts")).find(
      (c) => c.email === enterpriseLead.email,
    );
    // Referral leads go to the enterprise team (round robin starts with Dev).
    expect(contact).toMatchObject({ company: "Globex", source: "referral", ownerId: "u_dev" });

    const approvals = await get<Approval[]>("/api/approvals");
    expect(approvals).toEqual([
      expect.objectContaining({
        runId,
        status: "pending",
        approverId: "u_ava",
        title: "Enterprise lead: Globex (1200 employees)",
      }),
    ]);
    // The resume token never leaves the server.
    const raw = await (await call("GET", "/api/approvals")).text();
    expect(raw).not.toMatch(/resume|token/i);
    expect(JSON.stringify(await runDetail(runId))).not.toContain("/resume/");
    expect(await get<OutboxMessage[]>("/api/outbox")).toEqual([]);

    const approvalId = approvals[0]?.id as string;
    const decided = await call("POST", `/api/approvals/${approvalId}/decision`, {
      decision: "approved",
    });
    expect(decided.status).toBe(202);
    expect(await decided.json()).toMatchObject({ approval: { status: "approved" } });
    await crm.engine.drain();

    expect((await runDetail(runId)).run.status).toBe("completed");
    const outbox = await get<OutboxMessage[]>("/api/outbox");
    expect(outbox).toEqual([
      expect.objectContaining({ to: "dev@acme.test", subject: "Enterprise lead approved" }),
    ]);
    expect(outbox[0]?.body).toContain("Hank Scorpio from Globex");

    // A decided approval cannot be decided again.
    const again = await call("POST", `/api/approvals/${approvalId}/decision`, {
      decision: "rejected",
    });
    expect(again.status).toBe(409);
  });

  it("stops the run without email when the manager rejects", async () => {
    const runId = await postLead(enterpriseLead, "lead-2");
    const [approval] = await get<Approval[]>("/api/approvals");
    const res = await call("POST", `/api/approvals/${approval?.id}/decision`, {
      decision: "rejected",
    });
    expect(res.status).toBe(202);
    await crm.engine.drain();

    const detail = await runDetail(runId);
    expect(detail.run.status).toBe("completed");
    expect(detail.events.some((e) => e.type === "run.stopped")).toBe(true);
    expect(await get<OutboxMessage[]>("/api/outbox")).toEqual([]);
  });

  it("treats an approval that times out as rejected", async () => {
    const runId = await postLead(enterpriseLead, "lead-3");
    now += 3 * 86_400_000 + 1;
    await crm.engine.drain();

    expect((await runDetail(runId)).run.status).toBe("completed");
    const [approval] = await get<Approval[]>("/api/approvals");
    expect(approval?.status).toBe("expired");
    expect(await get<OutboxMessage[]>("/api/outbox")).toEqual([]);
    const late = await call("POST", `/api/approvals/${approval?.id}/decision`, {
      decision: "approved",
    });
    expect(late.status).toBe(409);
  });

  it("accepts only the first of two concurrent decisions", async () => {
    await postLead(enterpriseLead, "lead-7");
    const [approval] = await get<Approval[]>("/api/approvals");
    const path = `/api/approvals/${approval?.id}/decision`;
    const statuses = await Promise.all([
      call("POST", path, { decision: "approved" }),
      call("POST", path, { decision: "rejected" }),
    ]).then((rs) => rs.map((r) => r.status));
    expect(statuses).toEqual([202, 409]);
    await crm.engine.drain();
    expect((await get<Approval[]>("/api/approvals"))[0]?.status).toBe("approved");
    expect(await get<OutboxMessage[]>("/api/outbox")).toHaveLength(1);
  });

  it("answers 410 and expires the approval when its run was cancelled", async () => {
    const runId = await postLead(enterpriseLead, "lead-8");
    expect((await call("POST", `/flowkit/runs/${runId}/cancel`)).status).toBe(200);
    const [approval] = await get<Approval[]>("/api/approvals");
    const res = await call("POST", `/api/approvals/${approval?.id}/decision`, {
      decision: "approved",
    });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: "gone", approval: { status: "expired" } });
  });

  it("starts no second run when the webhook is replayed with the same X-Request-Id", async () => {
    const runId = await postLead(enterpriseLead, "lead-4");
    const replay = await call("POST", await webhookPath(), enterpriseLead, {
      "X-Request-Id": "lead-4",
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ runId, deduped: true });
    await crm.engine.drain();

    expect((await runsOf("inbound-lead-routing")).map((r) => r.id)).toEqual([runId]);
    expect(await get<Approval[]>("/api/approvals")).toHaveLength(1);
  });

  it("welcomes a small lead directly, with an owner from the SMB team", async () => {
    const runId = await postLead(
      {
        email: "marge@kwik.test",
        firstName: "Marge",
        lastName: "Simpson",
        source: "web",
        employees: 12,
      },
      "lead-5",
    );
    expect((await runDetail(runId)).run.status).toBe("completed");
    expect(await get<Approval[]>("/api/approvals")).toEqual([]);
    const contact = (await get<Contact[]>("/api/contacts")).find(
      (c) => c.email === "marge@kwik.test",
    );
    expect(contact?.ownerId).toBe("u_ben");
    expect(await get<OutboxMessage[]>("/api/outbox")).toEqual([
      expect.objectContaining({ to: "marge@kwik.test", subject: "Welcome to Acme" }),
    ]);
  });

  it("rejects a lead missing required fields", async () => {
    const res = await call("POST", await webhookPath(), { email: "x@y.test" });
    expect(res.status).toBe(400);
  });
});

describe("deal won follow-up", () => {
  it("emails the customer of a big won deal one minute later", async () => {
    const res = await call("PATCH", "/api/deals/d_1", { stage: "won" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      deal: { id: "d_1", stage: "won" },
      changes: ["stage"],
    });
    await crm.engine.drain();

    const [run] = await runsOf("deal-won-follow-up");
    expect(run?.status).toBe("waiting");
    expect(await get<OutboxMessage[]>("/api/outbox")).toEqual([]);

    now += 60_000;
    await crm.engine.drain();
    expect((await runDetail(run?.id as string)).run.status).toBe("completed");
    const outbox = await get<OutboxMessage[]>("/api/outbox");
    expect(outbox).toEqual([
      expect.objectContaining({
        to: "grace@navy.test",
        subject: "Thank you, Grace: Navy Labs expansion is confirmed",
      }),
    ]);
    expect(outbox[0]?.body).toContain("($48,000)");
  });

  it("stops for a small deal", async () => {
    await call("PATCH", "/api/deals/d_3", { stage: "won" });
    await crm.engine.drain();

    const [run] = await runsOf("deal-won-follow-up");
    const detail = await runDetail(run?.id as string);
    expect(detail.run.status).toBe("completed");
    expect(detail.events.find((e) => e.type === "run.stopped")?.data).toMatchObject({
      reason: "Small deal",
    });
    now += 60_000;
    await crm.engine.drain();
    expect(await get<OutboxMessage[]>("/api/outbox")).toEqual([]);
  });

  it("ignores changes that do not move the deal to won", async () => {
    await call("PATCH", "/api/deals/d_1", { amount: 50_000 });
    await call("PATCH", "/api/deals/d_2", { stage: "proposal" });
    await crm.engine.drain();
    expect(await runsOf("deal-won-follow-up")).toEqual([]);
  });
});

describe("get-or-create-contact sub-flow", () => {
  it("creates the contact once, then finds it", async () => {
    const input = { email: "lisa@springfield.test", firstName: "Lisa", lastName: "Simpson" };
    const before = (await get<Contact[]>("/api/contacts")).length;

    const first = await crm.engine.start({
      tenantId: TENANT_ID,
      workflowId: "get-or-create-contact",
      input,
    });
    await crm.engine.drain();
    const created = (await runDetail(first)).run;
    expect(created.status).toBe("completed");
    expect(created.output).toMatchObject({ created: true, contact: { email: input.email } });

    const second = await crm.engine.start({
      tenantId: TENANT_ID,
      workflowId: "get-or-create-contact",
      input,
    });
    await crm.engine.drain();
    const found = (await runDetail(second)).run;
    expect(found.output).toMatchObject({ created: false });
    expect((found.output as { contact: Contact }).contact.id).toBe(
      (created.output as { contact: Contact }).contact.id,
    );
    expect(await get<Contact[]>("/api/contacts")).toHaveLength(before + 1);
  });
});

describe("CRM API", () => {
  it("lists the seed data", async () => {
    expect(await get<unknown[]>("/api/contacts")).toHaveLength(12);
    expect(await get<unknown[]>("/api/deals")).toHaveLength(8);
    expect(await get<unknown[]>("/api/users")).toHaveLength(5);
  });

  it("creates contacts and validates input", async () => {
    const res = await call("POST", "/api/contacts", {
      firstName: "Bart",
      lastName: "Simpson",
      email: "bart@springfield.test",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: "c_13", ownerId: null });
    expect((await call("POST", "/api/contacts", { firstName: "No email" })).status).toBe(400);
    const dup = await call("POST", "/api/contacts", {
      firstName: "Bart",
      lastName: "Again",
      email: "BART@springfield.test",
    });
    expect(dup.status).toBe(409);
  });

  it("rejects unknown deals, stages and fields", async () => {
    expect((await call("PATCH", "/api/deals/nope", { stage: "won" })).status).toBe(404);
    expect((await call("PATCH", "/api/deals/d_1", { stage: "closed" })).status).toBe(400);
    expect((await call("PATCH", "/api/deals/d_1", { contactId: "c_2" })).status).toBe(400);
  });

  it("resets the CRM to its seed data", async () => {
    await postLead({ ...enterpriseLead, employees: 3 }, "lead-6");
    expect(await get<unknown[]>("/api/outbox")).toHaveLength(1);
    expect((await call("POST", "/api/demo/reset")).status).toBe(204);
    expect(await get<unknown[]>("/api/contacts")).toHaveLength(12);
    expect(await get<unknown[]>("/api/outbox")).toEqual([]);
  });

  it("serves the engine under /flowkit", async () => {
    const manifest = await get<{ plugins: { id: string }[] }>("/flowkit/manifest");
    expect(manifest.plugins.map((p) => p.id)).toEqual(["core", "crm"]);
    const workflows =
      await get<{ id: string; publishedVersion: number | null }[]>("/flowkit/workflows");
    expect(workflows.map((w) => w.id).sort()).toEqual(demoFlows.map((d) => d.id).sort());
    expect(workflows.every((w) => w.publishedVersion === 1)).toBe(true);
  });
});
