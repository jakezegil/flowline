import {
  createRegistry,
  defineNode,
  definePlugin,
  defineTrigger,
  type WorkflowDoc,
} from "@flowline/core";
import { createMemoryStorage } from "@flowline/storage-memory";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createEngine, type Engine } from "./engine";
import type { StorageAdapter } from "./storage";

const DealUpdated = z.object({ dealId: z.string(), changes: z.array(z.string()) });

const dealUpdated = defineTrigger({
  type: "crm.dealUpdated",
  name: "Deal updated",
  kind: "event",
  event: "deal.updated",
  config: z.object({ onlyWhenStageChanges: z.boolean().default(false) }),
  payload: DealUpdated,
  filter: ({ config, payload }) =>
    !config.onlyWhenStageChanges || payload.changes.includes("stage"),
  dedupeKey: ({ payload }) => (payload.dealId === "d-dedupe" ? "fixed" : undefined),
});

const echo = defineNode({
  type: "crm.echo",
  name: "Echo",
  input: z.object({ value: z.unknown() }),
  run: ({ input }) => ({ value: input.value }),
});

const registry = createRegistry([
  definePlugin({ id: "crm", name: "CRM", nodes: [echo], triggers: [dealUpdated] }),
]);

const steps: WorkflowDoc["steps"] = [
  { id: "e", type: "crm.echo", config: { value: { $ref: "trigger.dealId" } } },
];

const dealDoc = (id: string, onlyWhenStageChanges = false): WorkflowDoc => ({
  id,
  name: id,
  trigger: { type: "crm.dealUpdated", config: { onlyWhenStageChanges } },
  steps,
});

const eventDoc = (id: string, event: string): WorkflowDoc => ({
  id,
  name: id,
  trigger: { type: "core.event", config: { event } },
  steps: [{ id: "e", type: "crm.echo", config: { value: { $ref: "trigger" } } }],
});

const manualDoc = (id: string): WorkflowDoc => ({
  id,
  name: id,
  trigger: {
    type: "core.manual",
    config: { fields: [{ name: "count", type: "number", required: true }] },
  },
  steps: [{ id: "e", type: "crm.echo", config: { value: { $ref: "trigger.count" } } }],
});

let storage: StorageAdapter;
let engine: Engine;
const now = Date.UTC(2026, 0, 1);

async function deploy(doc: WorkflowDoc, tenant = "t1") {
  const v = await engine.saveWorkflow(tenant, doc, "u");
  await engine.publish(tenant, doc.id, v.version, "u");
}

beforeEach(() => {
  storage = createMemoryStorage();
  engine = createEngine({ registry, storage, clock: () => now });
});

describe("emit", () => {
  it("starts a run per matching published workflow, honouring filters", async () => {
    await deploy(dealDoc("any"));
    await deploy(dealDoc("stage-only", true));
    await deploy(eventDoc("other-event", "deal.deleted"));
    await deploy(dealDoc("elsewhere"), "t2");

    const ids = await engine.emit(
      "deal.updated",
      { dealId: "d1", changes: ["amount"] },
      { tenantId: "t1" },
    );
    expect(ids).toHaveLength(1);
    const run = await storage.getRun("t1", ids[0] as string);
    expect(run).toMatchObject({
      workflowId: "any",
      status: "queued",
      trigger: { dealId: "d1", changes: ["amount"] },
      startedBy: { kind: "event", event: "deal.updated" },
    });

    const both = await engine.emit(
      "deal.updated",
      { dealId: "d2", changes: ["stage"] },
      { tenantId: "t1" },
    );
    expect(both).toHaveLength(2);
    expect(await storage.listRuns("t2", {})).toEqual([]);
    const events = await storage.listEvents("t1", ids[0] as string);
    expect(events.map((e) => e.type)).toEqual(["run.started"]);
  });

  it("matches core.event triggers by their configured event name", async () => {
    await deploy(eventDoc("on-signup", "user.signedUp"));
    const ids = await engine.emit("user.signedUp", { id: 7 }, { tenantId: "t1" });
    expect(ids).toHaveLength(1);
    await engine.drain();
    expect((await storage.getRun("t1", ids[0] as string))?.status).toBe("completed");
    expect(await engine.emit("user.deleted", {}, { tenantId: "t1" })).toEqual([]);
  });

  it("starts at most one run per dedupe key", async () => {
    await deploy(dealDoc("any"));
    await deploy(dealDoc("any2"));
    const payload = { dealId: "d1", changes: [] };
    const first = await engine.emit("deal.updated", payload, { tenantId: "t1", dedupeKey: "k1" });
    const second = await engine.emit("deal.updated", payload, { tenantId: "t1", dedupeKey: "k1" });
    expect(first).toHaveLength(2);
    expect(second).toEqual([]);
    expect(await storage.listRuns("t1", {})).toHaveLength(2);
    // The trigger's own dedupeKey() applies when no key is passed.
    const viaTrigger = { dealId: "d-dedupe", changes: [] };
    expect(await engine.emit("deal.updated", viaTrigger, { tenantId: "t1" })).toHaveLength(2);
    expect(await engine.emit("deal.updated", viaTrigger, { tenantId: "t1" })).toEqual([]);
    expect(await storage.listRuns("t1", {})).toHaveLength(4);
  });

  it("rejects an invalid payload before creating any run", async () => {
    await deploy(eventDoc("generic", "deal.updated"));
    await deploy(dealDoc("typed"));
    await expect(
      engine.emit("deal.updated", { dealId: 5 }, { tenantId: "t1" }),
    ).rejects.toMatchObject({ name: "FlowlineValidationError", issues: [expect.any(Object)] });
    expect(await storage.listRuns("t1", {})).toEqual([]);
  });
});

describe("start", () => {
  it("starts the published version with validated input", async () => {
    await deploy(manualDoc("m"));
    const id = await engine.start({ tenantId: "t1", workflowId: "m", input: { count: 3 } });
    expect(await storage.getRun("t1", id)).toMatchObject({
      trigger: { count: 3 },
      startedBy: { kind: "manual" },
      version: 1,
    });
    const custom = await engine.start({
      tenantId: "t1",
      workflowId: "m",
      input: { count: 1 },
      startedBy: { kind: "manual", userId: "u9" },
    });
    expect((await storage.getRun("t1", custom))?.startedBy).toEqual({
      kind: "manual",
      userId: "u9",
    });
  });

  it("rejects invalid input, unpublished workflows and duplicate dedupe keys", async () => {
    await deploy(manualDoc("m"));
    await expect(
      engine.start({ tenantId: "t1", workflowId: "m", input: { count: "3" } }),
    ).rejects.toMatchObject({ name: "FlowlineValidationError" });
    await expect(engine.start({ tenantId: "t1", workflowId: "m" })).rejects.toMatchObject({
      name: "FlowlineValidationError",
    });
    await expect(
      engine.start({ tenantId: "t2", workflowId: "m", input: { count: 1 } }),
    ).rejects.toThrow(/not published/);
    expect(await storage.listRuns("t1", {})).toEqual([]);

    const a = await engine.start({
      tenantId: "t1",
      workflowId: "m",
      input: { count: 1 },
      dedupeKey: "once",
    });
    const b = await engine.start({
      tenantId: "t1",
      workflowId: "m",
      input: { count: 2 },
      dedupeKey: "once",
    });
    expect(b).toBe(a);
    expect(await storage.listRuns("t1", {})).toHaveLength(1);
  });
});
