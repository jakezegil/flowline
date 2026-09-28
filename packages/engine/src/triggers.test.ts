import {
  createRegistry,
  defineNode,
  definePlugin,
  defineTrigger,
  type Logger,
  type WorkflowDoc,
} from "@flowlinejs/core";
import { createMemoryStorage } from "@flowlinejs/storage-memory";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createEngine, type Engine } from "./engine";
import type { StorageAdapter } from "./storage";
import type { TriggerEvent } from "./trigger-events";

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

/** Requires `amount`, unlike {@link dealUpdated}: used to make exactly one of several matches reject. */
const dealAmountChanged = defineTrigger({
  type: "crm.dealAmountChanged",
  name: "Deal amount changed",
  kind: "event",
  event: "deal.updated",
  config: z.object({}),
  payload: DealUpdated.extend({ amount: z.number() }),
});

/** A trigger whose `filter`/`dedupeKey` throw depending on `config.throwIn`, for isolation tests. */
const throwy = defineTrigger({
  type: "crm.throwy",
  name: "Throwy",
  kind: "event",
  event: "deal.updated",
  config: z.object({ throwIn: z.enum(["filter", "dedupeKey"]) }),
  payload: DealUpdated,
  filter: ({ config }) => {
    if (config.throwIn === "filter") throw new Error("boom");
    return true;
  },
  dedupeKey: ({ config }) => {
    if (config.throwIn === "dedupeKey") throw new Error("boom");
    return undefined;
  },
});

const echo = defineNode({
  type: "crm.echo",
  name: "Echo",
  input: z.object({ value: z.unknown() }),
  run: ({ input }) => ({ value: input.value }),
});

const registry = createRegistry([
  definePlugin({
    id: "crm",
    name: "CRM",
    nodes: [echo],
    triggers: [dealUpdated, dealAmountChanged, throwy],
  }),
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

const dealAmountDoc = (id: string): WorkflowDoc => ({
  id,
  name: id,
  trigger: { type: "crm.dealAmountChanged", config: {} },
  steps,
});

const throwyDoc = (id: string, throwIn: "filter" | "dedupeKey"): WorkflowDoc => ({
  id,
  name: id,
  trigger: { type: "crm.throwy", config: { throwIn } },
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

    const result = await engine.emit(
      "deal.updated",
      { dealId: "d1", changes: ["amount"] },
      { tenantId: "t1" },
    );
    expect(result.rejected).toEqual([]);
    expect(result.started).toHaveLength(1);
    const run = await storage.getRun("t1", result.started[0] as string);
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
    expect(both.started).toHaveLength(2);
    expect(await storage.listRuns("t2", {})).toEqual([]);
    const events = await storage.listEvents("t1", result.started[0] as string);
    expect(events.map((e) => e.type)).toEqual(["run.started"]);
  });

  it("matches core.event triggers by their configured event name", async () => {
    await deploy(eventDoc("on-signup", "user.signedUp"));
    const result = await engine.emit("user.signedUp", { id: 7 }, { tenantId: "t1" });
    expect(result.started).toHaveLength(1);
    await engine.drain();
    expect((await storage.getRun("t1", result.started[0] as string))?.status).toBe("completed");
    expect(await engine.emit("user.deleted", {}, { tenantId: "t1" })).toEqual({
      started: [],
      rejected: [],
    });
  });

  it("starts at most one run per dedupe key", async () => {
    await deploy(dealDoc("any"));
    await deploy(dealDoc("any2"));
    const payload = { dealId: "d1", changes: [] };
    const first = await engine.emit("deal.updated", payload, { tenantId: "t1", dedupeKey: "k1" });
    const second = await engine.emit("deal.updated", payload, { tenantId: "t1", dedupeKey: "k1" });
    expect(first.started).toHaveLength(2);
    expect(second.started).toEqual([]);
    expect(await storage.listRuns("t1", {})).toHaveLength(2);
    // The trigger's own dedupeKey() applies when no key is passed.
    const viaTrigger = { dealId: "d-dedupe", changes: [] };
    expect(
      (await engine.emit("deal.updated", viaTrigger, { tenantId: "t1" })).started,
    ).toHaveLength(2);
    expect((await engine.emit("deal.updated", viaTrigger, { tenantId: "t1" })).started).toEqual([]);
    expect(await storage.listRuns("t1", {})).toHaveLength(4);
  });

  it("returns { started: [], rejected: [] } when nothing matches the event", async () => {
    await deploy(dealDoc("any"));
    expect(await engine.emit("nothing.listens", {}, { tenantId: "t1" })).toEqual({
      started: [],
      rejected: [],
    });
  });

  it("isolates one match's invalid payload: the rest start, one rejection is reported", async () => {
    const events: TriggerEvent[] = [];
    const warn = vi.fn();
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    engine = createEngine({
      registry,
      storage,
      clock: () => now,
      logger,
      onTriggerEvent: (e) => events.push(e),
    });
    await deploy(dealDoc("a")); // crm.dealUpdated: accepts { dealId, changes }
    await deploy(eventDoc("b", "deal.updated")); // core.event: payload z.unknown()
    await deploy(dealAmountDoc("c")); // crm.dealAmountChanged: also requires `amount`

    const result = await engine.emit(
      "deal.updated",
      { dealId: "d1", changes: ["amount"] },
      { tenantId: "t1" },
    );

    expect(result.started).toHaveLength(2);
    const startedWorkflows = await Promise.all(
      result.started.map(async (id) => (await storage.getRun("t1", id))?.workflowId),
    );
    expect(new Set(startedWorkflows)).toEqual(new Set(["a", "b"]));

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toMatchObject({
      workflowId: "c",
      version: 1,
      message: expect.stringContaining("amount"),
    });
    expect(result.rejected[0]?.issues[0]).toMatchObject({ code: "config.invalid" });

    const rejections = events.filter((e) => e.type === "trigger.rejected");
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({
      type: "trigger.rejected",
      tenantId: "t1",
      workflowId: "c",
      version: 1,
      source: { kind: "event", event: "deal.updated" },
    });
    expect(rejections[0]).not.toHaveProperty("payload");

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("rejects a match whose filter throws, `message` starting `filter threw:`; others unaffected", async () => {
    await deploy(dealDoc("any"));
    await deploy(throwyDoc("bad", "filter"));
    const result = await engine.emit(
      "deal.updated",
      { dealId: "d1", changes: [] },
      { tenantId: "t1" },
    );
    expect(result.started).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.workflowId).toBe("bad");
    expect(result.rejected[0]?.message).toMatch(/^filter threw:/);
  });

  it("rejects a match whose dedupeKey throws; other matches unaffected", async () => {
    await deploy(dealDoc("any"));
    await deploy(throwyDoc("bad", "dedupeKey"));
    const result = await engine.emit(
      "deal.updated",
      { dealId: "d1", changes: [] },
      { tenantId: "t1" },
    );
    expect(result.started).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.workflowId).toBe("bad");
    expect(result.rejected[0]?.message).toMatch(/^dedupeKey threw:/);
  });

  it("a filter returning false is skipped: neither started nor rejected", async () => {
    await deploy(dealDoc("stage-only", true));
    const result = await engine.emit(
      "deal.updated",
      { dealId: "d1", changes: ["amount"] },
      { tenantId: "t1" },
    );
    expect(result).toEqual({ started: [], rejected: [] });
  });

  it("a throwing onTriggerEvent is logged and does not fail emit", async () => {
    const warn = vi.fn();
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    engine = createEngine({
      registry,
      storage,
      clock: () => now,
      logger,
      onTriggerEvent: () => {
        throw new Error("listener boom");
      },
    });
    await deploy(dealAmountDoc("c")); // missing `amount` in the payload below: rejects
    const result = await engine.emit(
      "deal.updated",
      { dealId: "d1", changes: [] },
      { tenantId: "t1" },
    );
    expect(result.rejected).toHaveLength(1);
    // One warn for the rejection itself, one for the listener throwing.
    expect(warn).toHaveBeenCalledTimes(2);
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
