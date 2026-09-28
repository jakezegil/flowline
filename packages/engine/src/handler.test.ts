import { createHmac } from "node:crypto";
import {
  branch,
  createRegistry,
  defineNode,
  definePlugin,
  defineTrigger,
  type Issue,
  type Logger,
  type RunDetail,
  type RunEvent,
  secret,
  sensitive,
  suspend,
  type WorkflowDoc,
} from "@flowkit/core";
import { createMemoryStorage } from "@flowkit/storage-memory";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createEngine, type Engine, type EngineOptions } from "./engine";
import type { StorageAdapter } from "./storage";

const echo = defineNode({
  type: "t.echo",
  name: "Echo",
  input: z.object({ value: z.unknown() }),
  run: ({ input }) => ({ value: input.value }),
});

/** Looks up a customer; its output and `ssn` input are sensitive. */
const lookup = defineNode({
  type: "t.lookup",
  name: "Lookup",
  input: z.object({ ssn: sensitive(z.string()) }),
  output: z.object({ name: z.string(), card: sensitive(z.string()) }),
  run: () => ({ name: "Ada", card: "4111-1111" }),
});

const pause = defineNode({
  type: "t.pause",
  name: "Pause",
  input: z.object({}),
  run: ({ ctx }) => (ctx.resume ? { resumed: true } : suspend({ until: ctx.now() + 60_000 })),
});

/** Waits for a callback whose body is `{ decision }`; `host` nodes are resumed by the host app. */
const decisionWait = (type: string, hostHandled: boolean) =>
  defineNode({
    type,
    name: "Decision",
    input: z.object({}),
    resume: { body: z.object({ decision: z.enum(["approved", "rejected"]) }), hostHandled },
    run: async ({ ctx }) => {
      if (ctx.resume?.kind === "callback") return { body: ctx.resume.body };
      return suspend({ callback: await ctx.callback({ timeoutMs: 3_600_000 }) });
    },
  });

const registry = createRegistry([
  definePlugin({
    id: "t",
    name: "Test",
    nodes: [
      echo,
      lookup,
      pause,
      decisionWait("t.decide", false),
      decisionWait("t.hostDecide", true),
    ],
  }),
]);

function manualDoc(id: string, steps: WorkflowDoc["steps"] = []): WorkflowDoc {
  return {
    id,
    name: `Workflow ${id}`,
    trigger: {
      type: "core.manual",
      config: { fields: [{ name: "name", type: "string", required: true }] },
    },
    steps:
      steps.length > 0
        ? steps
        : [{ id: "greet", type: "t.echo", config: { value: { $tpl: "Hi {{trigger.name}}" } } }],
  };
}

function webhookDoc(id: string, config: Record<string, unknown> = {}): WorkflowDoc {
  return {
    id,
    name: `Hook ${id}`,
    trigger: {
      type: "core.webhook",
      config: { fields: [{ name: "email", type: "string", required: true }], ...config } as never,
    },
    steps: [{ id: "show", type: "t.echo", config: { value: { $ref: "trigger.body.email" } } }],
  };
}

const waitDoc = (id: string): WorkflowDoc => ({
  id,
  name: "Approval",
  trigger: { type: "core.manual", config: {} },
  steps: [
    {
      id: "approval",
      type: "core.waitForCallback",
      config: { timeout: "1h" },
      branches: { resumed: [], timeout: [] },
    },
  ],
});

let storage: StorageAdapter;
let engine: Engine;
let now: number;
let logger: Logger;

function makeEngine(extra: Partial<EngineOptions> = {}, store: StorageAdapter = storage): Engine {
  return createEngine({
    registry,
    storage: store,
    clock: () => now,
    logger,
    secrets: {
      get: async (tenantId, name) => (name === "HOOK_KEY" ? `key-of-${tenantId}` : undefined),
      list: async (tenantId) => [`${tenantId.toUpperCase()}_TOKEN`, "HOOK_KEY"],
    },
    authorize: async (req) => {
      const tenant = req.headers.get("x-tenant");
      return tenant ? { tenantId: tenant, userId: `user-${tenant}` } : null;
    },
    ...extra,
  });
}

beforeEach(() => {
  storage = createMemoryStorage();
  now = Date.UTC(2026, 0, 1, 10, 0);
  logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  engine = makeEngine();
});

interface CallOpts {
  tenant?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
}

function call(method: string, path: string, opts: CallOpts = {}, e: Engine = engine) {
  const headers: Record<string, string> = { ...opts.headers };
  const tenant = opts.tenant === undefined ? "a" : opts.tenant;
  if (tenant !== null) headers["x-tenant"] = tenant;
  const init: RequestInit = { method, headers };
  // Like the client: every mutation declares JSON.
  if (method !== "GET") headers["content-type"] ??= "application/json";
  if (opts.body !== undefined) {
    init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  return e.handler(new Request(`http://localhost/flowkit${path}`, init));
}

async function json<T = unknown>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

/** Saves and publishes `doc` for `tenant` through the engine API. */
async function deploy(doc: WorkflowDoc, tenant = "a") {
  const v = await engine.saveWorkflow(tenant, doc, "setup");
  await engine.publish(tenant, doc.id, v.version, "setup");
  return v;
}

describe("routing and authorization", () => {
  it("serves the manifest", async () => {
    const res = await call("GET", "/manifest");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const manifest = await json<{ nodes: { type: string }[] }>(res);
    expect(manifest.nodes.map((n) => n.type)).toContain("t.echo");
  });

  it("answers unknown routes with 404 JSON", async () => {
    const res = await call("GET", "/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect((await call("GET", "/", {}, engine)).status).toBe(404);
    const outside = await engine.handler(new Request("http://localhost/other/manifest"));
    expect(outside.status).toBe(404);
  });

  it("rejects editor requests authorize returns null for with 401", async () => {
    const res = await call("GET", "/workflows", { tenant: null });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it("uses a default tenant without authorize and warns once", async () => {
    const open = makeEngine({ authorize: undefined });
    await open.saveWorkflow("default", manualDoc("wf"), "x");
    const first = await call("GET", "/workflows", { tenant: null }, open);
    expect(first.status).toBe(200);
    expect((await json<{ id: string }[]>(first)).map((w) => w.id)).toEqual(["wf"]);
    await call("GET", "/workflows", { tenant: null }, open);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("refuses editor mutations with a non-JSON content type (CSRF)", async () => {
    await deploy(manualDoc("wf"));
    const form = await call("POST", "/workflows/wf/run", {
      body: JSON.stringify({ input: { name: "x" } }),
      headers: { "content-type": "text/plain" },
    });
    expect(form.status).toBe(415);
    expect(await storage.listRuns("a", {})).toEqual([]);
    const bare = await engine.handler(
      new Request("http://localhost/flowkit/workflows/wf/run", {
        method: "POST",
        headers: { "x-tenant": "a", "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ input: { name: "x" } }),
      }),
    );
    expect(bare.status).toBe(202);
    // A no-cors fetch with an untyped Blob body sends no Content-Type at all.
    const untyped = await engine.handler(
      new Request("http://localhost/flowkit/workflows/wf/run", {
        method: "POST",
        headers: { "x-tenant": "a" },
        body: new Blob([JSON.stringify({ input: { name: "y" } })]),
      }),
    );
    expect(untyped.status).toBe(415);
    const bodyless = await engine.handler(
      new Request(
        `http://localhost/flowkit/runs/${(await storage.listRuns("a", {}))[0]?.id}/cancel`,
        {
          method: "POST",
          headers: { "x-tenant": "a" },
        },
      ),
    );
    expect(bodyless.status).toBe(415);
    expect(await storage.listRuns("a", {})).toHaveLength(1);
  });

  it("answers 404 for a malformed percent-encoding", async () => {
    const res = await call("GET", "/runs/%E0%A4%A");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it("answers 413 for a body over 1 MiB, declared or streamed", async () => {
    const big = JSON.stringify({ pad: "x".repeat(1_100_000) });
    const declared = await call("POST", "/workflows/validate", { body: big });
    expect(declared.status).toBe(413);
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 20) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const streamed = await engine.handler(
      new Request("http://localhost/flowkit/workflows/validate", {
        method: "POST",
        headers: { "x-tenant": "a", "content-type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    expect(streamed.status).toBe(413);
  });

  it("honours a custom basePath", async () => {
    const mounted = makeEngine({ basePath: "/api/flows/" });
    const res = await mounted.handler(
      new Request("http://localhost/api/flows/manifest", { headers: { "x-tenant": "a" } }),
    );
    expect(res.status).toBe(200);
  });
});

describe("tenant isolation", () => {
  it("never shows or touches another tenant's workflows and runs", async () => {
    await deploy(manualDoc("wf-a"), "a");
    await deploy(manualDoc("wf-b"), "b");
    const runA = await engine.start({ tenantId: "a", workflowId: "wf-a", input: { name: "A" } });

    expect((await json<{ id: string }[]>(call("GET", "/workflows"))).map((w) => w.id)).toEqual([
      "wf-a",
    ]);
    const listB = await json<{ id: string }[]>(call("GET", "/workflows", { tenant: "b" }));
    expect(listB.map((w) => w.id)).toEqual(["wf-b"]);
    expect((await call("GET", "/workflows/wf-a", { tenant: "b" })).status).toBe(404);

    expect((await call("GET", `/runs/${runA}`, { tenant: "b" })).status).toBe(404);
    expect(await json(call("GET", "/runs", { tenant: "b" }))).toEqual([]);
    expect((await call("POST", `/runs/${runA}/retry`, { tenant: "b" })).status).toBe(404);
    expect((await call("POST", `/runs/${runA}/cancel`, { tenant: "b" })).status).toBe(404);
    expect((await call("GET", `/runs/${runA}/stream`, { tenant: "b" })).status).toBe(404);
    expect((await call("POST", "/workflows/wf-a/run", { tenant: "b", body: {} })).status).toBe(404);
    // Nothing happened to A's run.
    expect((await storage.getRun("a", runA))?.status).toBe("queued");
    expect((await call("GET", `/runs/${runA}`)).status).toBe(200);
  });
});

describe("workflow management", () => {
  it("saves a new version with PUT and reads it back", async () => {
    const res = await call("PUT", "/workflows/wf", { body: manualDoc("wf") });
    expect(res.status).toBe(200);
    const v = await json<{ version: number; createdBy: string }>(res);
    expect(v).toMatchObject({ version: 1, createdBy: "user-a" });
    const detail = await json<{ latest: { version: number }; published: unknown }>(
      call("GET", "/workflows/wf"),
    );
    expect(detail).toMatchObject({ latest: { version: 1 }, published: null });
  });

  it("with ?create=true saves only a workflow that doesn't exist yet (409 workflow_exists)", async () => {
    const created = await call("PUT", "/workflows/wf?create=true", { body: manualDoc("wf") });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ version: 1 });
    const again = await call("PUT", "/workflows/wf?create=true", {
      body: { ...manualDoc("wf"), name: "Blank" },
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "workflow_exists" });
    expect((await storage.getLatestVersion("a", "wf"))?.version).toBe(1);
    // Without it, a save is the next version as before.
    expect(
      await json<{ version: number }>(call("PUT", "/workflows/wf", { body: manualDoc("wf") })),
    ).toMatchObject({ version: 2 });
    expect(
      (await call("PUT", "/workflows/wf?create=maybe", { body: manualDoc("wf") })).status,
    ).toBe(400);
  });

  it("rejects a save whose body id differs from the URL", async () => {
    const res = await call("PUT", "/workflows/other", { body: manualDoc("wf") });
    expect(res.status).toBe(400);
    expect((await call("PUT", "/workflows/wf", { body: "{nope" })).status).toBe(400);
    expect((await call("PUT", "/workflows/wf", { body: { id: "wf" } })).status).toBe(400);
  });

  it("generates a webhook slug on first save and keeps it", async () => {
    const v1 = await engine.saveWorkflow("a", webhookDoc("hook"), "u");
    const slug = (v1.doc.trigger.config as { slug?: string }).slug;
    expect(slug).toMatch(/^[A-Za-z0-9_-]{24}$/);
    // A later save without the slug keeps the existing one.
    const v2 = await engine.saveWorkflow("a", webhookDoc("hook"), "u");
    expect((v2.doc.trigger.config as { slug?: string }).slug).toBe(slug);
    const other = await engine.saveWorkflow("a", webhookDoc("hook2"), "u");
    expect((other.doc.trigger.config as { slug?: string }).slug).not.toBe(slug);
    // Non-webhook workflows get none.
    const manual = await engine.saveWorkflow("a", manualDoc("m"), "u");
    expect(manual.doc.trigger.config).not.toHaveProperty("slug");
  });

  it("replaces a supplied slug shorter than 22 characters", async () => {
    const weak = await engine.saveWorkflow("a", webhookDoc("w", { slug: "a".repeat(21) }), "u");
    expect((weak.doc.trigger.config as { slug: string }).slug).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const strong = "b".repeat(22);
    const kept = await engine.saveWorkflow("a", webhookDoc("s", { slug: strong }), "u");
    expect((kept.doc.trigger.config as { slug: string }).slug).toBe(strong);
  });

  it("publishing an invalid doc answers 422 with issues", async () => {
    const bad = manualDoc("bad", [{ id: "x", type: "t.missing", config: {} }]);
    await call("PUT", "/workflows/bad", { body: bad });
    const res = await call("POST", "/workflows/bad/publish", { body: { version: 1 } });
    expect(res.status).toBe(422);
    const body = await json<{ issues: Issue[] }>(res);
    expect(body.issues.map((i) => i.code)).toContain("node.unknown");
    expect(await storage.getPublishedVersion("a", "bad")).toBeNull();
    await expect(engine.publish("a", "bad", 1, "u")).rejects.toMatchObject({
      name: "FlowkitValidationError",
      issues: expect.arrayContaining([expect.objectContaining({ code: "node.unknown" })]),
    });
  });

  it("publishing a valid doc answers 200 and writes the audit trail", async () => {
    await call("PUT", "/workflows/wf", { body: manualDoc("wf") });
    const res = await call("POST", "/workflows/wf/publish", { body: { version: 1 } });
    expect(res.status).toBe(200);
    expect((await storage.getPublishedVersion("a", "wf"))?.version).toBe(1);
    const audit = await storage.listWorkflowAudit("a", "wf");
    expect(audit.map((e) => [e.action, e.version, e.actor])).toEqual([
      ["saved", 1, "user-a"],
      ["published", 1, "user-a"],
    ]);
    expect((await call("POST", "/workflows/wf/publish", { body: { version: 9 } })).status).toBe(
      404,
    );
    expect((await call("POST", "/workflows/wf/publish", { body: {} })).status).toBe(400);
  });

  it("validates a doc with POST /workflows/validate", async () => {
    const issues = await json<Issue[]>(
      call("POST", "/workflows/validate", {
        body: manualDoc("v", [{ id: "x", type: "t.missing", config: {} }]),
      }),
    );
    expect(issues.map((i) => i.code)).toContain("node.unknown");
    expect(await json(call("POST", "/workflows/validate", { body: manualDoc("v") }))).toEqual([]);
  });

  it("validates sub-flow calls against the tenant's published sub-flows", async () => {
    const sub: WorkflowDoc = {
      id: "enrich",
      name: "Enrich",
      trigger: {
        type: "core.subflow",
        config: {
          input: [{ name: "email", type: "string", required: true }],
          output: [{ name: "score", type: "number" }],
        },
      },
      steps: [{ id: "noop", type: "t.echo", config: { value: 1 } }],
      output: { score: 1 },
    };
    await deploy(sub, "a");
    const caller = manualDoc("caller", [
      {
        id: "call",
        type: "core.callSubflow",
        config: { workflowId: "enrich", input: { email: "x@y.z" } },
      },
    ]);
    expect(await engine.validate("a", caller)).toEqual([]);
    const forB = await engine.validate("b", caller);
    expect(forB.map((i) => i.code)).toContain("subflow.unknown");

    const subflows = await json<{ id: string; input: unknown; output: unknown }[]>(
      call("GET", "/subflows"),
    );
    expect(subflows).toEqual([
      {
        id: "enrich",
        name: "Enrich",
        input: expect.objectContaining({ properties: { email: expect.any(Object) } }),
        output: expect.objectContaining({ properties: { score: expect.any(Object) } }),
      },
    ]);
    expect(await json(call("GET", "/subflows", { tenant: "b" }))).toEqual([]);
  });

  it("lists secret names from secrets.list", async () => {
    expect(await json(call("GET", "/secrets"))).toEqual(["A_TOKEN", "HOOK_KEY"]);
    const none = makeEngine({ secrets: { get: async () => undefined } });
    expect(await json(call("GET", "/secrets", {}, none))).toEqual([]);
  });
});

describe("runs", () => {
  it("starts a manual run and validates its input", async () => {
    await deploy(manualDoc("wf"));
    const res = await call("POST", "/workflows/wf/run", { body: { input: { name: "Ada" } } });
    expect(res.status).toBe(202);
    const { runId } = await json<{ runId: string }>(res);
    const run = await storage.getRun("a", runId);
    expect(run).toMatchObject({
      trigger: { name: "Ada" },
      startedBy: { kind: "manual", userId: "user-a" },
    });

    const bad = await call("POST", "/workflows/wf/run", { body: { input: { name: 5 } } });
    expect(bad.status).toBe(400);
    expect(await json(bad)).toMatchObject({ issues: [expect.any(Object)] });
    expect(await storage.listRuns("a", {})).toHaveLength(1);
    expect((await call("POST", "/workflows/none/run", { body: {} })).status).toBe(404);
  });

  it("lists runs with filters", async () => {
    await deploy(manualDoc("wf"));
    await deploy(manualDoc("wf2"));
    await engine.start({ tenantId: "a", workflowId: "wf", input: { name: "1" } });
    await engine.start({ tenantId: "a", workflowId: "wf2", input: { name: "2" } });
    expect(await json<unknown[]>(call("GET", "/runs"))).toHaveLength(2);
    const onlyWf = await json<{ workflowId: string }[]>(call("GET", "/runs?workflowId=wf"));
    expect(onlyWf.map((r) => r.workflowId)).toEqual(["wf"]);
    expect(await json(call("GET", "/runs?status=completed"))).toEqual([]);
    expect(await json<unknown[]>(call("GET", "/runs?limit=1"))).toHaveLength(1);
    expect((await call("GET", "/runs?status=bogus")).status).toBe(400);
    expect((await call("GET", "/runs?limit=-3")).status).toBe(400);
    // topLevel=true is passed on to storage; anything but true/false is refused.
    const listRuns = vi.spyOn(storage, "listRuns");
    expect(await json<unknown[]>(call("GET", "/runs?topLevel=true"))).toHaveLength(2);
    expect(listRuns).toHaveBeenLastCalledWith("a", { topLevel: true });
    await call("GET", "/runs?topLevel=false");
    expect(listRuns).toHaveBeenLastCalledWith("a", {});
    expect((await call("GET", "/runs?topLevel=yes")).status).toBe(400);
    await call("GET", "/runs?status=completed&stopped=false");
    expect(listRuns).toHaveBeenLastCalledWith("a", { status: "completed", stopped: false });
    await call("GET", "/runs?stopped=true");
    expect(listRuns).toHaveBeenLastCalledWith("a", { stopped: true });
    expect((await call("GET", "/runs?stopped=1")).status).toBe(400);
  });

  it("returns run detail without the callback token and with sensitive values masked", async () => {
    await deploy(
      manualDoc("mixed", [
        { id: "who", type: "t.lookup", config: { ssn: "123-45-6789" } },
        ...waitDoc("x").steps,
      ]),
    );
    const runId = await engine.start({ tenantId: "a", workflowId: "mixed", input: { name: "A" } });
    await engine.drain();
    const stored = await storage.getRun("a", runId);
    expect(stored?.status).toBe("waiting");
    const token = stored?.callbackToken;
    expect(token).toBeTruthy();
    // The journal keeps sensitive values raw (downstream refs need them)...
    expect(JSON.stringify(stored?.journal)).toContain("4111-1111");

    const res = await call("GET", `/runs/${runId}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(token as string);
    expect(text).not.toContain("callbackToken");
    expect(text).not.toContain("leaseOwner");
    // ...but the run detail masks them (the SSN literal still shows in the pinned doc's config).
    const detail = JSON.parse(text) as RunDetail;
    expect(text).not.toContain("4111-1111");
    expect(JSON.stringify(detail.run)).not.toContain("123-45-6789");
    expect(detail.run).toMatchObject({ id: runId, status: "waiting", workflowId: "mixed" });
    const who = detail.run.journal.who as { input: unknown; output: unknown };
    expect(who.input).toEqual({ ssn: "[redacted]" });
    expect(who.output).toEqual({ name: "Ada", card: "[redacted]" });
    expect(detail.doc.id).toBe("mixed");
    expect(detail.events[0]?.type).toBe("run.started");
  });

  it("retries a failed run and 409s otherwise", async () => {
    const failing = defineNode({
      type: "u.fail",
      name: "Fail",
      input: z.object({}),
      retry: { max: 1 },
      run: () => {
        throw new Error("boom");
      },
    });
    const e = makeEngine({
      registry: createRegistry([definePlugin({ id: "u", name: "U", nodes: [failing] })]),
    });
    const v = await e.saveWorkflow(
      "a",
      manualDoc("f", [{ id: "f", type: "u.fail", config: {} }]),
      "u",
    );
    await e.publish("a", "f", v.version, "u");
    const runId = await e.start({ tenantId: "a", workflowId: "f", input: { name: "x" } });
    expect((await call("POST", `/runs/${runId}/retry`, {}, e)).status).toBe(409);
    await e.drain();
    const res = await call("POST", `/runs/${runId}/retry`, {}, e);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId });
    expect((await call("POST", "/runs/nope/retry", {}, e)).status).toBe(404);
  });

  it("answers 500 when retrying fails for another reason than the run's state", async () => {
    await deploy(manualDoc("wf"));
    const runId = await engine.start({ tenantId: "a", workflowId: "wf", input: { name: "x" } });
    await storage.updateRunUnleased(
      "a",
      runId,
      { status: ["queued"] },
      { status: "failed" },
      [],
      now,
    );
    const broken: StorageAdapter = {
      ...storage,
      updateRunUnleased: () => Promise.reject(new Error("db down")),
    };
    const e = makeEngine({}, broken);
    const res = await call("POST", `/runs/${runId}/retry`, {}, e);
    expect(res.status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith("flowkit handler error", { error: "db down" });
  });

  it("maps cancel outcomes to 200, 202 and 409", async () => {
    await deploy(manualDoc("wf"));
    const queued = await engine.start({ tenantId: "a", workflowId: "wf", input: { name: "x" } });
    const res = await call("POST", `/runs/${queued}/cancel`);
    expect(res.status).toBe(200);
    expect((await storage.getRun("a", queued))?.status).toBe("cancelled");
    // The cancel records who asked for it.
    const events = await storage.listEvents("a", queued);
    expect(events.find((e) => e.type === "run.cancelled")?.data).toEqual({ by: "user-a" });
    const again = await call("POST", `/runs/${queued}/cancel`);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "finished" });

    const running = await engine.start({ tenantId: "a", workflowId: "wf", input: { name: "y" } });
    await storage.claimRun({ workerId: "other", leaseMs: 60_000, now });
    const requested = await call("POST", `/runs/${running}/cancel`);
    expect(requested.status).toBe(202);
    expect((await call("POST", "/runs/nope/cancel")).status).toBe(404);
  });

  it("records no actor on a cancel without authorize (nobody is signed in)", async () => {
    // Same storage, so the open engine sees the run the authorized one started.
    const open = makeEngine({ authorize: undefined });
    await deploy(manualDoc("wf"), "default");
    const runId = await engine.start({
      tenantId: "default",
      workflowId: "wf",
      input: { name: "x" },
    });
    const res = await call("POST", `/runs/${runId}/cancel`, { tenant: null }, open);
    expect(res.status).toBe(200);
    const events = await storage.listEvents("default", runId);
    expect(events.find((e) => e.type === "run.cancelled")?.data).toBeUndefined();
  });
});

describe("resume", () => {
  async function waitingRun(tenant = "a") {
    await deploy(waitDoc("approve"), tenant);
    const runId = await engine.start({ tenantId: tenant, workflowId: "approve" });
    await engine.drain();
    const run = await storage.getRun(tenant, runId);
    expect(run?.status).toBe("waiting");
    return { runId, token: run?.callbackToken as string };
  }

  it("resumes by token once, then answers 410 gone", async () => {
    const { runId, token } = await waitingRun();
    const res = await call("POST", `/resume/${token}`, { tenant: null, body: { ok: true } });
    expect(res.status).toBe(202);
    const gone = await call("POST", `/resume/${token}`, { tenant: null, body: { ok: true } });
    expect(gone.status).toBe(410);
    expect(await gone.json()).toEqual({ error: "gone" });
    await engine.drain();
    const run = await storage.getRun("a", runId);
    expect(run?.status).toBe("completed");
    expect(run?.journal.approval).toMatchObject({ output: { body: { ok: true } } });
  });

  it("resumes through the authorized route, recording who, and hides other tenants' runs", async () => {
    const { runId } = await waitingRun();
    const other = await call("POST", `/runs/${runId}/resume`, { tenant: "b", body: { x: 1 } });
    expect([404, 410]).toContain(other.status);
    expect((await storage.getRun("a", runId))?.status).toBe("waiting");

    const res = await call("POST", `/runs/${runId}/resume`, { body: { approved: true } });
    expect(res.status).toBe(202);
    const events = await storage.listEvents("a", runId);
    expect(events.find((e) => e.type === "run.resumed")?.data).toEqual({
      kind: "callback",
      by: "user-a",
    });
    expect((await call("POST", `/runs/${runId}/resume`, { body: {} })).status).toBe(410);
  });

  async function decisionRun(type: string) {
    const doc: WorkflowDoc = {
      id: "decide",
      name: "Decide",
      trigger: { type: "core.manual", config: {} },
      steps: [{ id: "decide", type, config: {} }],
    };
    await deploy(doc, "a");
    const runId = await engine.start({ tenantId: "a", workflowId: "decide" });
    await engine.drain();
    const run = await storage.getRun("a", runId);
    expect(run?.status).toBe("waiting");
    return { runId, token: run?.callbackToken as string };
  }

  it("refuses a host-handled step on the generic route with 409 resume_host_handled", async () => {
    const { runId } = await decisionRun("t.hostDecide");
    const body = { decision: "approved" };
    const res = await call("POST", `/runs/${runId}/resume`, { body });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "resume_host_handled" });
    const withStep = await call("POST", `/runs/${runId}/resume?step=decide`, { body });
    expect(withStep.status).toBe(409);
    expect((await storage.getRun("a", runId))?.status).toBe("waiting");
    // The host's own code resumes it in-process.
    expect(await engine.resumeRun("a", runId, body, "boss", { expectStep: "decide" })).toBe(
      "resumed",
    );
  });

  it("checks the body against the node's resume.body on the authorized route (400)", async () => {
    const { runId } = await decisionRun("t.decide");
    const bad = await call("POST", `/runs/${runId}/resume`, { body: { decision: "maybe" } });
    expect(bad.status).toBe(400);
    const err = (await bad.json()) as { error: string; issues: unknown[] };
    expect(err.error).toMatch(/Resume body for step "decide": field "decision"/);
    expect(err.issues).toHaveLength(1);
    expect((await storage.getRun("a", runId))?.status).toBe("waiting");
    const ok = await call("POST", `/runs/${runId}/resume`, { body: { decision: "rejected" } });
    expect(ok.status).toBe(202);
    await engine.drain();
    expect((await storage.getRun("a", runId))?.journal.decide).toMatchObject({
      output: { body: { decision: "rejected" } },
    });
  });

  it("checks the body on the public token route too, keeping the token usable", async () => {
    const { runId, token } = await decisionRun("t.hostDecide");
    const bad = await call("POST", `/resume/${token}`, { tenant: null, body: {} });
    expect(bad.status).toBe(400);
    expect((await storage.getRun("a", runId))?.status).toBe("waiting");
    const ok = await call("POST", `/resume/${token}`, {
      tenant: null,
      body: { decision: "approved" },
    });
    expect(ok.status).toBe(202);
  });

  it("answers 409 resume_unverifiable on both routes when the wait can't be checked", async () => {
    const { runId, token } = await decisionRun("t.decide");
    const real = storage.getWorkflowVersion.bind(storage);
    storage.getWorkflowVersion = async () => null;
    try {
      const body = { decision: "approved" };
      for (const res of [
        await call("POST", `/resume/${token}`, { tenant: null, body }),
        await call("POST", `/runs/${runId}/resume`, { body }),
      ]) {
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: "resume_unverifiable" });
      }
    } finally {
      storage.getWorkflowVersion = real;
    }
    expect((await storage.getRun("a", runId))?.status).toBe("waiting");
    const ok = await call("POST", `/resume/${token}`, {
      tenant: null,
      body: { decision: "approved" },
    });
    expect(ok.status).toBe(202);
  });

  it("resumes only at the step named by ?step", async () => {
    const { runId } = await waitingRun();
    const wrong = await call("POST", `/runs/${runId}/resume?step=elsewhere`, { body: {} });
    expect(wrong.status).toBe(410);
    expect(await wrong.json()).toEqual({ error: "gone" });
    expect((await storage.getRun("a", runId))?.status).toBe("waiting");

    const res = await call("POST", `/runs/${runId}/resume?step=approval`, { body: { ok: 1 } });
    expect(res.status).toBe(202);
    await engine.drain();
    expect((await storage.getRun("a", runId))?.status).toBe("completed");
  });
});

describe("webhooks", () => {
  async function hook(config: Record<string, unknown> = {}, tenant = "a") {
    const v = await deploy(webhookDoc("hook", config), tenant);
    return (v.doc.trigger.config as { slug: string }).slug;
  }

  const post = (path: string, body: string, headers: Record<string, string> = {}) =>
    engine.handler(
      new Request(`http://localhost/flowkit${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      }),
    );

  it("starts a run with the body and answers 202", async () => {
    const slug = await hook();
    const res = await post(`/hooks/a/hook/${slug}`, JSON.stringify({ email: "a@b.c" }));
    expect(res.status).toBe(202);
    const { runId } = await json<{ runId: string }>(res);
    const run = await storage.getRun("a", runId);
    expect(run?.trigger).toMatchObject({ body: { email: "a@b.c" } });
    expect(run?.startedBy).toEqual({ kind: "webhook" });
  });

  it("answers 404 for a wrong slug, tenant or workflow", async () => {
    const slug = await hook();
    const body = JSON.stringify({ email: "a@b.c" });
    expect((await post("/hooks/a/hook/wrong-slug-wrong-slug-xx", body)).status).toBe(404);
    expect((await post(`/hooks/b/hook/${slug}`, body)).status).toBe(404);
    expect((await post(`/hooks/a/other/${slug}`, body)).status).toBe(404);
    expect(await storage.listRuns("a", {})).toEqual([]);
  });

  it("verifies the HMAC signature when a signing secret is configured", async () => {
    const slug = await hook({ secret: "HOOK_KEY" });
    const body = JSON.stringify({ email: "a@b.c" });
    const good = createHmac("sha256", "key-of-a").update(body).digest("hex");
    const bad = createHmac("sha256", "other").update(body).digest("hex");
    expect((await post(`/hooks/a/hook/${slug}`, body)).status).toBe(401);
    expect(
      (await post(`/hooks/a/hook/${slug}`, body, { "x-flowkit-signature": `sha256=${bad}` }))
        .status,
    ).toBe(401);
    expect(
      (await post(`/hooks/a/hook/${slug}`, body, { "x-flowkit-signature": "sha256=abc" })).status,
    ).toBe(401);
    expect(await storage.listRuns("a", {})).toEqual([]);
    const ok = await post(`/hooks/a/hook/${slug}`, body, {
      "x-flowkit-signature": `sha256=${good}`,
    });
    expect(ok.status).toBe(202);
  });

  it("won't publish a signing secret taken from the payload, and fails closed if one is stored", async () => {
    const doc = webhookDoc("hook", { secret: { $ref: "trigger.body.which" } });
    const v = await engine.saveWorkflow("a", doc, "setup");
    await expect(engine.publish("a", "hook", v.version, "setup")).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "config.invalid", field: "trigger.secret" })],
    });
    // Published behind the validator's back: no signature can match, so nothing starts.
    await storage.publishVersion("a", "hook", v.version, now);
    const slug = (v.doc.trigger.config as { slug: string }).slug;
    const body = JSON.stringify({ email: "a@b.c", which: "HOOK_KEY" });
    const sig = createHmac("sha256", "key-of-a").update(body).digest("hex");
    const res = await post(`/hooks/a/hook/${slug}`, body, {
      "x-flowkit-signature": `sha256=${sig}`,
    });
    expect(res.status).toBe(401);
    expect(await storage.listRuns("a", {})).toEqual([]);
  });

  it("rejects a body that does not match the declared fields with 400", async () => {
    const slug = await hook();
    const res = await post(`/hooks/a/hook/${slug}`, JSON.stringify({ name: "no email" }));
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({
      error: expect.any(String),
      issues: [expect.any(Object)],
    });
    expect((await post(`/hooks/a/hook/${slug}`, "{not json")).status).toBe(400);
    expect(await storage.listRuns("a", {})).toEqual([]);
  });

  it("starts one run per dedupe header value", async () => {
    const slug = await hook({ dedupeHeader: "X-Request-Id" });
    const body = JSON.stringify({ email: "a@b.c" });
    const first = await post(`/hooks/a/hook/${slug}`, body, { "x-request-id": "req-1" });
    expect(first.status).toBe(202);
    const { runId } = await json<{ runId: string }>(first);
    const second = await post(`/hooks/a/hook/${slug}`, body, { "x-request-id": "req-1" });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ runId, deduped: true });
    expect(await storage.listRuns("a", {})).toHaveLength(1);
    const third = await post(`/hooks/a/hook/${slug}`, body, { "x-request-id": "req-2" });
    expect(third.status).toBe(202);
    expect(await storage.listRuns("a", {})).toHaveLength(2);
  });

  it("applies a plugin webhook trigger's filter and dedupeKey", async () => {
    const invoiceHook = defineTrigger({
      type: "p.invoice",
      name: "Invoice",
      kind: "webhook",
      config: z.object({}),
      payload: z.object({ body: z.object({ type: z.string(), id: z.string() }) }),
      filter: ({ payload }) => payload.body.type === "invoice.paid",
      dedupeKey: ({ payload }) => payload.body.id,
    });
    const e = makeEngine({
      registry: createRegistry([
        definePlugin({ id: "t", name: "Test", nodes: [echo] }),
        definePlugin({ id: "p", name: "P", triggers: [invoiceHook] }),
      ]),
    });
    const doc: WorkflowDoc = {
      id: "inv",
      name: "Invoices",
      trigger: { type: "p.invoice", config: {} },
      steps: [{ id: "show", type: "t.echo", config: { value: { $ref: "trigger.body.id" } } }],
    };
    const v = await e.saveWorkflow("a", doc, "u");
    await e.publish("a", "inv", v.version, "u");
    const slug = (v.doc.trigger.config as { slug: string }).slug;
    const send = (body: unknown) =>
      e.handler(
        new Request(`http://localhost/flowkit/hooks/a/inv/${slug}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

    const skipped = await send({ type: "invoice.created", id: "in_1" });
    expect(skipped.status).toBe(200);
    expect(await skipped.json()).toEqual({ skipped: true });
    expect(await storage.listRuns("a", {})).toEqual([]);

    const first = await send({ type: "invoice.paid", id: "in_1" });
    expect(first.status).toBe(202);
    const { runId } = await json<{ runId: string }>(first);
    const again = await send({ type: "invoice.paid", id: "in_1" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ runId, deduped: true });
    expect(await storage.listRuns("a", {})).toHaveLength(1);
  });

  it("stores lowercased headers without credentials", async () => {
    const slug = await hook();
    const res = await post(`/hooks/a/hook/${slug}`, JSON.stringify({ email: "a@b.c" }), {
      Authorization: "Bearer secret",
      Cookie: "session=1",
      "Proxy-Authorization": "Basic x",
      "X-Api-Key": "k",
      "Stripe-Signature": "t=1,v1=abc",
      "X-Auth-Token": "tok",
      "X-Custom": "Kept",
    });
    const { runId } = await json<{ runId: string }>(res);
    const run = await storage.getRun("a", runId);
    if (!run) throw new Error("run missing");
    const headers = (run.trigger as { headers: object }).headers;
    expect(headers).toMatchObject({ "x-custom": "Kept", "content-type": "application/json" });
    expect(Object.keys(headers)).not.toContain("authorization");
    expect(Object.keys(headers)).not.toContain("cookie");
    expect(Object.keys(headers)).not.toContain("proxy-authorization");
    expect(Object.keys(headers)).not.toContain("x-api-key");
    expect(Object.keys(headers)).not.toContain("stripe-signature");
    expect(Object.keys(headers)).not.toContain("x-auth-token");
    expect(Object.keys(headers).some((k) => k !== k.toLowerCase())).toBe(false);
  });
});

/** Reads SSE frames from `res` until a terminal event or `timeoutMs`. */
async function readFrames(res: Response, timeoutMs = 5_000) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: { event: string; id: string; data: RunEvent }[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const timeout = new Promise<{ done: true; value: undefined }>((r) =>
      setTimeout(() => r({ done: true, value: undefined }), Math.max(0, deadline - Date.now())),
    );
    const { done, value } = await Promise.race([reader.read(), timeout]);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      idx = buffer.indexOf("\n\n");
      if (block.startsWith(":")) continue;
      const fields = Object.fromEntries(
        block.split("\n").map((line) => {
          const colon = line.indexOf(":");
          return [line.slice(0, colon), line.slice(colon + 1).trimStart()];
        }),
      );
      frames.push({
        event: fields.event ?? "",
        id: fields.id ?? "",
        data: JSON.parse(fields.data ?? "null"),
      });
    }
  }
  await reader.cancel().catch(() => {});
  return frames;
}

describe("SSE stream", () => {
  it("streams a run's events and closes after the terminal one", async () => {
    await deploy(manualDoc("wf"));
    const runId = await engine.start({ tenantId: "a", workflowId: "wf", input: { name: "x" } });
    const res = await call("GET", `/runs/${runId}/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reading = readFrames(res);
    await engine.drain();
    const frames = await reading;
    expect(frames.map((f) => f.data.type)).toEqual([
      "run.started",
      "step.started",
      "step.completed",
      "run.completed",
    ]);
    expect(frames.every((f) => f.event === "run" && f.id === String(f.data.seq))).toBe(true);
  });

  it("resumes after the given seq", async () => {
    await deploy(manualDoc("wf"));
    const runId = await engine.start({ tenantId: "a", workflowId: "wf", input: { name: "x" } });
    await engine.drain();
    const frames = await readFrames(await call("GET", `/runs/${runId}/stream?after=2`));
    expect(frames.map((f) => f.data.seq)).toEqual([3, 4]);
    // Already past the terminal event: the stream closes without frames.
    expect(await readFrames(await call("GET", `/runs/${runId}/stream?after=4`), 3_000)).toEqual([]);
  });

  it("stops polling and heartbeats when the client goes away", async () => {
    await deploy(manualDoc("wf"));
    const runId = await engine.start({ tenantId: "a", workflowId: "wf", input: { name: "x" } });
    const clear = vi.spyOn(globalThis, "clearInterval");
    try {
      const aborter = new AbortController();
      const res = await engine.handler(
        new Request(`http://localhost/flowkit/runs/${runId}/stream`, {
          headers: { "x-tenant": "a" },
          signal: aborter.signal,
        }),
      );
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      aborter.abort();
      await expect.poll(() => clear.mock.calls.length).toBeGreaterThanOrEqual(2);
      const other = await call("GET", `/runs/${runId}/stream`);
      await (other.body as ReadableStream<Uint8Array>).cancel();
      await expect.poll(() => clear.mock.calls.length).toBeGreaterThanOrEqual(4);
    } finally {
      clear.mockRestore();
    }
  });

  it("closes after run.stopped", async () => {
    await deploy(manualDoc("wf", [{ id: "halt", type: "core.stop", config: {} }]));
    const runId = await engine.start({ tenantId: "a", workflowId: "wf", input: { name: "x" } });
    await engine.drain();
    const frames = await readFrames(await call("GET", `/runs/${runId}/stream`));
    expect(frames.at(-1)?.data.type).toBe("run.stopped");
  });

  it("does not end on a failure the run was retried past", async () => {
    let fail = true;
    const flaky = defineNode({
      type: "u.flaky",
      name: "Flaky",
      input: z.object({}),
      retry: { max: 1 },
      run: () => {
        if (fail) throw new Error("boom");
        return { ok: true };
      },
    });
    const e = makeEngine({
      registry: createRegistry([definePlugin({ id: "u", name: "U", nodes: [flaky] })]),
    });
    const v = await e.saveWorkflow(
      "a",
      manualDoc("f", [{ id: "f", type: "u.flaky", config: {} }]),
      "u",
    );
    await e.publish("a", "f", v.version, "u");
    const runId = await e.start({ tenantId: "a", workflowId: "f", input: { name: "x" } });
    await e.drain();
    fail = false;
    await e.retryRun("a", runId);
    // Opened after the retry, before it ran: history holds the old run.failed.
    const reading = readFrames(await call("GET", `/runs/${runId}/stream`, {}, e));
    await new Promise((r) => setTimeout(r, 50));
    await e.drain();
    const types = (await reading).map((f) => f.data.type);
    expect(types).toContain("run.failed");
    expect(types.at(-1)).toBe("run.completed");

    // Replaying the finished history in full still closes after its last event.
    const replay = await readFrames(await call("GET", `/runs/${runId}/stream`, {}, e), 3_000);
    expect(replay.map((f) => f.data.type)).toEqual(types);
  });

  it("receives events committed by another engine through storage polling", async () => {
    const worker = makeEngine();
    await deploy(manualDoc("wf"));
    const runId = await engine.start({ tenantId: "a", workflowId: "wf", input: { name: "x" } });
    const reading = readFrames(await call("GET", `/runs/${runId}/stream`));
    await new Promise((r) => setTimeout(r, 50));
    await worker.drain();
    const frames = await reading;
    expect(frames.map((f) => f.data.type)).toEqual([
      "run.started",
      "step.started",
      "step.completed",
      "run.completed",
    ]);
  });
});

describe("subscribe", () => {
  it("delivers every event of a run, in order, fed by commits", async () => {
    await deploy(manualDoc("wf"));
    const runId = await engine.start({ tenantId: "a", workflowId: "wf", input: { name: "x" } });
    const seen: RunEvent[] = [];
    const off = engine.subscribe(runId, (e) => seen.push(e));
    await engine.drain();
    await vi.waitFor(() => expect(seen.at(-1)?.type).toBe("run.completed"));
    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    off();
  });
});

describe("test-step", () => {
  it("resolves config against the samples and reports output and duration", async () => {
    const res = await call("POST", "/workflows/wf/test-step", {
      body: {
        step: { id: "greet", type: "t.echo", config: { value: { $tpl: "Hi {{trigger.name}}" } } },
        doc: manualDoc("wf"),
        samples: {},
        triggerSample: { name: "Ada" },
      },
    });
    expect(res.status).toBe(200);
    const body = await json<{ ok: boolean; output: unknown; durationMs: number; input: unknown }>(
      res,
    );
    expect(body).toMatchObject({
      ok: true,
      output: { value: "Hi Ada" },
      input: { value: "Hi Ada" },
    });
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("masks secret output fields and keeps sensitive ones visible", async () => {
    const issue = defineNode({
      type: "u.issue",
      name: "Issue key",
      input: z.object({}),
      output: z.object({ id: z.string(), key: secret(z.string()), card: sensitive(z.string()) }),
      run: () => ({ id: "k1", key: "sk_live_123", card: "4111" }),
    });
    const pick = defineNode({
      type: "u.pick",
      name: "Pick",
      input: z.object({}),
      output: z.object({ key: secret(z.string()) }),
      branches: {
        kind: "static",
        branches: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
      },
      run: () => branch("a", { key: "sk_live_456" }),
    });
    const e = makeEngine({
      registry: createRegistry([definePlugin({ id: "u", name: "U", nodes: [issue, pick] })]),
    });
    const plain = await e.testStep("a", {
      step: { id: "i", type: "u.issue", config: {} },
      doc: manualDoc("wf", [{ id: "i", type: "u.issue", config: {} }]),
      samples: {},
    });
    expect(plain).toMatchObject({ ok: true, output: { id: "k1", card: "4111" } });
    expect(JSON.stringify(plain)).not.toContain("sk_live_123");
    const branched = await e.testStep("a", {
      step: { id: "p", type: "u.pick", config: {}, branches: { a: [], b: [] } },
      doc: manualDoc("wf", [{ id: "p", type: "u.pick", config: {}, branches: { a: [], b: [] } }]),
      samples: {},
    });
    expect(branched).toMatchObject({ ok: true, branch: "a" });
    expect(JSON.stringify(branched)).not.toContain("sk_live_456");
  });

  it("uses step samples and reports suspension without executing it", async () => {
    const out = await engine.testStep("a", {
      step: { id: "wait", type: "t.pause", config: {} },
      doc: manualDoc("wf"),
      samples: { greet: { value: "x" } },
    });
    expect(out).toMatchObject({ ok: true, signal: "suspend" });
    const withSample = await engine.testStep("a", {
      step: { id: "e", type: "t.echo", config: { value: { $ref: "steps.greet.value" } } },
      doc: manualDoc("wf"),
      samples: { greet: { value: "from sample" } },
    });
    expect(withSample).toMatchObject({ ok: true, output: { value: "from sample" } });
    expect(await storage.listRuns("a", {})).toEqual([]);
  });

  it("reports a callback wait as a suspension and invalid input as an error", async () => {
    const cb = await engine.testStep("a", {
      step: waitDoc("w").steps[0] as WorkflowDoc["steps"][number],
      doc: waitDoc("w"),
      samples: {},
    });
    expect(cb).toMatchObject({ ok: true, signal: "suspend" });
    const bad = await engine.testStep("a", {
      step: { id: "who", type: "t.lookup", config: { ssn: 5 } },
      doc: manualDoc("wf"),
      samples: {},
    });
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining("ssn") });
    const unknown = await engine.testStep("a", {
      step: { id: "x", type: "t.nope", config: {} },
      doc: manualDoc("wf"),
      samples: {},
    });
    expect(unknown).toMatchObject({ ok: false });
  });

  it("refuses to test a step whose secret field is a reference", async () => {
    const get = vi.fn(async () => "key");
    const e = makeEngine({ secrets: { get } });
    const out = await e.testStep("a", {
      step: {
        id: "h",
        type: "core.httpRequest",
        config: {
          method: "GET",
          url: "https://api.example.com",
          auth: { type: "bearer", secret: { $ref: "trigger.which" } },
        },
      },
      doc: manualDoc("wf"),
      triggerSample: { which: "HOOK_KEY" },
      samples: {},
    });
    expect(out).toMatchObject({
      ok: false,
      error: 'Step "h": field "auth.secret" holds a secret name and can\'t use a reference',
    });
    expect(get).not.toHaveBeenCalled();
  });
});

describe("validation through the engine", () => {
  it("warns about secret names that secrets.list doesn't know", async () => {
    const doc = webhookDoc("hook", { secret: "HOOK_KEY" });
    expect(await engine.validate("a", doc)).toEqual([]);
    const typo = webhookDoc("hook", { secret: "HOOK_KYE" });
    expect(await engine.validate("a", typo)).toEqual([
      expect.objectContaining({ code: "secret.unknown", severity: "warning" }),
    ]);
    // Without list, or when it fails, names aren't checked (and a failure is logged).
    const noList = makeEngine({ secrets: { get: async () => undefined } });
    expect(await noList.validate("a", typo)).toEqual([]);
    const failing = makeEngine({
      secrets: {
        get: async () => undefined,
        list: async () => {
          throw new Error("vault down");
        },
      },
    });
    expect(await failing.validate("a", typo)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "secrets.list failed; secret names are not checked",
      expect.objectContaining({ error: "vault down" }),
    );
  });

  it("names the first error in a rejected publish's message", async () => {
    const doc = manualDoc("wf", [
      { id: "a", type: "t.echo", config: { value: { $ref: "trigger.nmae" } } },
      { id: "b", type: "t.echo", config: { value: { $ref: "steps.zzz" } } },
    ]);
    const v = await engine.saveWorkflow("a", doc, "setup");
    await expect(engine.publish("a", "wf", v.version, "setup")).rejects.toThrow(
      'Workflow "wf" has errors: step "a": "value" references field "nmae", which doesn\'t exist on the trigger (+1 more)',
    );
  });

  it("checks references into a published sub-flow's declared input and output", async () => {
    await deploy({
      id: "notify",
      name: "Notify",
      trigger: {
        type: "core.subflow",
        config: {
          input: [{ name: "dealName", type: "string", required: true }],
          output: [{ name: "messageId", type: "string", required: true }],
        },
      },
      steps: [{ id: "e", type: "t.echo", config: { value: { $ref: "trigger.dealName" } } }],
      output: { messageId: { $ref: "steps.e.value" } },
    });
    const caller = (ref: string, input: Record<string, string> = { dealName: "Big" }) =>
      manualDoc("caller", [
        { id: "n", type: "core.callSubflow", config: { workflowId: "notify", input } },
        { id: "use", type: "t.echo", config: { value: { $ref: ref } } },
      ]);
    expect(await engine.validate("a", caller("steps.n.messageId"))).toEqual([]);
    expect(await engine.validate("a", caller("steps.n.msgId"))).toEqual([
      expect.objectContaining({ code: "ref.unresolved", stepId: "use" }),
    ]);
    expect(
      await engine.validate("a", caller("steps.n.messageId", { dealName: "Big", dealNme: "x" })),
    ).toEqual([expect.objectContaining({ code: "config.invalid", field: "input.dealNme" })]);
  });
});
