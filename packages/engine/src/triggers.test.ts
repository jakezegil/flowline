import {
  createRegistry,
  defineNode,
  definePlugin,
  defineTrigger,
  FlowlineDefinitionError,
  type Logger,
  type WorkflowDoc,
} from "@flowlinejs/core";
import { createMemoryStorage } from "@flowlinejs/storage-memory";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createEngine, type Engine, type EngineOptions } from "./engine";
import { FlowlineValidationError } from "./errors";
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
  dedupe: { key: ({ payload }) => (payload.dealId === "d-dedupe" ? "fixed" : undefined) },
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

/** A trigger whose `filter`/`dedupe.key` throw depending on `config.throwIn`, for isolation tests. */
const throwy = defineTrigger({
  type: "crm.throwy",
  name: "Throwy",
  kind: "event",
  event: "deal.updated",
  config: z.object({ throwIn: z.enum(["filter", "dedupe"]) }),
  payload: DealUpdated,
  filter: ({ config }) => {
    if (config.throwIn === "filter") throw new Error("boom");
    return true;
  },
  dedupe: {
    key: ({ config }) => {
      if (config.throwIn === "dedupe") throw new Error("boom");
      return undefined;
    },
  },
});

/** Keys deliveries by `dealId` (so a call-site key never applies), suppressing for 1 hour. */
const dealKeyed = defineTrigger({
  type: "crm.dealKeyed",
  name: "Deal keyed",
  kind: "event",
  event: "deal.keyed",
  config: z.object({}),
  payload: DealUpdated,
  dedupe: { key: ({ payload, event }) => `${event}/${payload.dealId}`, window: "1h" },
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
    triggers: [dealUpdated, dealAmountChanged, throwy, dealKeyed],
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

const throwyDoc = (id: string, throwIn: "filter" | "dedupe"): WorkflowDoc => ({
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

const dealKeyedDoc = (id: string): WorkflowDoc => ({
  id,
  name: id,
  trigger: { type: "crm.dealKeyed", config: {} },
  steps,
});

/** A core.event workflow that waits 5 minutes on a delay before echoing. */
const delayedEventDoc = (id: string, event: string): WorkflowDoc => ({
  id,
  name: id,
  trigger: { type: "core.event", config: { event } },
  steps: [
    { id: "wait", type: "core.delay", config: { duration: "5m" } },
    { id: "e", type: "crm.echo", config: { value: { $ref: "trigger" } } },
  ],
});

const RUN_ID = /^run_[0-9a-f]{32}$/;

let storage: StorageAdapter;
let engine: Engine;
const t0 = Date.UTC(2026, 0, 1);
let now = t0;

async function deploy(doc: WorkflowDoc, tenant = "t1") {
  const v = await engine.saveWorkflow(tenant, doc, "u");
  await engine.publish(tenant, doc.id, v.version, "u");
}

beforeEach(() => {
  now = t0;
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
    const opts = { tenantId: "t1", dedupe: { key: "k1" } };
    const first = await engine.emit("deal.updated", payload, opts);
    const second = await engine.emit("deal.updated", payload, opts);
    expect(first.started).toHaveLength(2);
    expect(second.started).toEqual([]);
    expect(await storage.listRuns("t1", {})).toHaveLength(2);
    // The trigger's own dedupe.key() applies when no key is passed.
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

  it("rejects a match whose dedupe.key throws; other matches unaffected", async () => {
    await deploy(dealDoc("any"));
    await deploy(throwyDoc("bad", "dedupe"));
    const result = await engine.emit(
      "deal.updated",
      { dealId: "d1", changes: [] },
      { tenantId: "t1" },
    );
    expect(result.started).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.workflowId).toBe("bad");
    expect(result.rejected[0]?.message).toMatch(/^dedupe\.key threw:/);
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
      dedupe: { key: "once" },
    });
    const b = await engine.start({
      tenantId: "t1",
      workflowId: "m",
      input: { count: 2 },
      dedupe: { key: "once" },
    });
    expect(b).toBe(a);
    expect(await storage.listRuns("t1", {})).toHaveLength(1);
  });
});

describe("dedupe windows", () => {
  /** An engine recording trigger events and `run.started` events delivered to `onEvent`. */
  function observed(extra: Partial<EngineOptions> = {}) {
    const triggerEvents: TriggerEvent[] = [];
    const runStarted: string[] = [];
    engine = createEngine({
      registry,
      storage,
      clock: () => now,
      onTriggerEvent: (e) => triggerEvents.push(e),
      onEvent: (e) => {
        if (e.type === "run.started") runStarted.push(e.runId);
      },
      ...extra,
    });
    return { triggerEvents, runStarted };
  }

  it("gives runs random IDs; a repeated key within the window returns the same ID once", async () => {
    const { triggerEvents } = observed();
    await deploy(manualDoc("m"));
    const start = (key?: string) =>
      engine.start({
        tenantId: "t1",
        workflowId: "m",
        input: { count: 1 },
        ...(key === undefined ? {} : { dedupe: { key } }),
      });
    const a = await start("a");
    const b = await start("b");
    const plain = await start();
    for (const id of [a, b, plain]) expect(id).toMatch(RUN_ID);
    expect(new Set([a, b, plain]).size).toBe(3);

    now += 1000;
    expect(await start("a")).toBe(a);
    expect(await storage.listRuns("t1", {})).toHaveLength(3);
    expect(triggerEvents).toEqual([
      {
        type: "trigger.deduped",
        at: now,
        tenantId: "t1",
        workflowId: "m",
        runId: a,
        key: "start:m:a",
        source: { kind: "manual" },
      },
    ]);
  });

  it("namespaces emit keys as event:<workflowId>:<key> and reports each suppressed match", async () => {
    const { triggerEvents } = observed();
    await deploy(eventDoc("on-signup", "user.signedUp"));
    const opts = { tenantId: "t1", dedupe: { key: "evt_1" } };
    const first = await engine.emit("user.signedUp", {}, opts);
    const second = await engine.emit("user.signedUp", {}, opts);
    expect(first.started).toHaveLength(1);
    expect(second).toEqual({ started: [], rejected: [] });
    expect(triggerEvents).toEqual([
      expect.objectContaining({
        type: "trigger.deduped",
        workflowId: "on-signup",
        runId: first.started[0],
        key: "event:on-signup:evt_1",
        source: { kind: "event", event: "user.signedUp" },
      }),
    ]);
  });

  it("recovers a crash between claiming the key and creating the run", async () => {
    let crashes = 1;
    const claimed: string[] = [];
    const { runStarted, triggerEvents } = observed({
      __testHooks: {
        afterDedupeClaim: (_tenantId, _key, runId) => {
          claimed.push(runId);
          if (crashes-- > 0) throw new Error("crash after claim");
        },
      },
    });
    await deploy(eventDoc("on-signup", "user.signedUp"));
    const opts = { tenantId: "t1", dedupe: { key: "evt_1" } };

    const crashed = await engine.emit("user.signedUp", {}, opts);
    expect(crashed.started).toEqual([]);
    expect(crashed.rejected).toEqual([
      expect.objectContaining({ workflowId: "on-signup", message: "crash after claim" }),
    ]);
    expect(await storage.listRuns("t1", {})).toEqual([]);
    expect(claimed).toHaveLength(1);
    const runId = claimed[0] as string;

    // The retry loses the claim to the crashed delivery and creates exactly that run. As spec §4.2
    // says, it is answered as a duplicate and its `run.started` reaches storage but not `onEvent`.
    const retry = await engine.emit("user.signedUp", {}, opts);
    expect(retry).toEqual({ started: [], rejected: [] });
    const runs = await storage.listRuns("t1", {});
    expect(runs.map((r) => r.id)).toEqual([runId]);
    const startedEvents = async () =>
      (await storage.listEvents("t1", runId)).filter((e) => e.type === "run.started");
    expect(await startedEvents()).toHaveLength(1);
    expect(runStarted).toEqual([]);
    expect(triggerEvents.filter((e) => e.type === "trigger.deduped")).toEqual([
      expect.objectContaining({ runId, key: "event:on-signup:evt_1" }),
    ]);

    // A third delivery is a plain duplicate; the run executes normally.
    expect(await engine.emit("user.signedUp", {}, opts)).toEqual({ started: [], rejected: [] });
    await engine.drain();
    expect((await storage.getRun("t1", runId))?.status).toBe("completed");
    expect(await startedEvents()).toHaveLength(1);
  });

  it("ten concurrent emits with one key start one run and all resolve its ID", async () => {
    const { triggerEvents, runStarted } = observed();
    await deploy(eventDoc("on-signup", "user.signedUp"));
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        engine.emit("user.signedUp", {}, { tenantId: "t1", dedupe: { key: "k" } }),
      ),
    );
    const started = results.flatMap((r) => r.started);
    expect(started).toHaveLength(1);
    expect(results.flatMap((r) => r.rejected)).toEqual([]);
    const deduped = triggerEvents.filter((e) => e.type === "trigger.deduped");
    expect(deduped).toHaveLength(9);
    for (const e of deduped) expect(e).toMatchObject({ runId: started[0] });
    expect(await storage.listRuns("t1", {})).toHaveLength(1);
    expect(runStarted).toEqual(started);
  });

  it("ten concurrent starts with one key all resolve the one run's ID", async () => {
    const { triggerEvents } = observed();
    await deploy(manualDoc("m"));
    const ids = await Promise.all(
      Array.from({ length: 10 }, () =>
        engine.start({
          tenantId: "t1",
          workflowId: "m",
          input: { count: 1 },
          dedupe: { key: "k" },
        }),
      ),
    );
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(RUN_ID);
    expect(await storage.listRuns("t1", {})).toHaveLength(1);
    expect(triggerEvents.filter((e) => e.type === "trigger.deduped")).toHaveLength(9);
  });

  it("a window expiring while the first run waits starts a second run; the first is untouched", async () => {
    await deploy(delayedEventDoc("slow", "user.signedUp"));
    const opts = { tenantId: "t1", dedupe: { key: "k", window: "1m" } };
    const first = await engine.emit("user.signedUp", {}, opts);
    await engine.drain();
    const firstId = first.started[0] as string;
    expect((await storage.getRun("t1", firstId))?.status).toBe("waiting");

    now += 59_999;
    expect((await engine.emit("user.signedUp", {}, opts)).started).toEqual([]);
    now = t0 + 61_000;
    const second = await engine.emit("user.signedUp", {}, opts);
    expect(second.started).toHaveLength(1);
    expect(second.started[0]).toMatch(RUN_ID);
    expect(second.started[0]).not.toBe(firstId);
    expect(await storage.getRun("t1", firstId)).toMatchObject({ status: "waiting", attempt: 1 });

    now = t0 + 10 * 60_000;
    await engine.drain();
    expect((await storage.getRun("t1", firstId))?.status).toBe("completed");
  });

  describe("key precedence", () => {
    it("emit: the trigger's dedupe.key beats opts.dedupe.key", async () => {
      await deploy(dealKeyedDoc("keyed"));
      const payload = { dealId: "d1", changes: [] };
      const a = await engine.emit("deal.keyed", payload, { tenantId: "t1", dedupe: { key: "x" } });
      const b = await engine.emit("deal.keyed", payload, { tenantId: "t1", dedupe: { key: "y" } });
      expect(a.started).toHaveLength(1);
      expect(b.started).toEqual([]);
      // Different trigger keys, same call-site key: not duplicates.
      const c = await engine.emit(
        "deal.keyed",
        { dealId: "d2", changes: [] },
        { tenantId: "t1", dedupe: { key: "x" } },
      );
      expect(c.started).toHaveLength(1);
    });

    it("emit: a trigger without dedupe, or whose key is undefined, uses opts.dedupe.key", async () => {
      await deploy(eventDoc("plain", "deal.updated")); // core.event: no dedupe
      await deploy(dealDoc("keyless")); // dedupe.key → undefined for d1
      const payload = { dealId: "d1", changes: [] };
      const x = { tenantId: "t1", dedupe: { key: "x" } };
      expect((await engine.emit("deal.updated", payload, x)).started).toHaveLength(2);
      expect((await engine.emit("deal.updated", payload, x)).started).toEqual([]);
      const y = { tenantId: "t1", dedupe: { key: "y" } };
      expect((await engine.emit("deal.updated", payload, y)).started).toHaveLength(2);
      // An empty call-site key is no key.
      const empty = { tenantId: "t1", dedupe: { key: "" } };
      expect((await engine.emit("deal.updated", payload, empty)).started).toHaveLength(2);
      expect((await engine.emit("deal.updated", payload, empty)).started).toHaveLength(2);
    });

    it("emit: the key function receives the delivered event name", async () => {
      const { triggerEvents } = observed();
      await deploy(dealKeyedDoc("keyed"));
      const payload = { dealId: "d1", changes: [] };
      await engine.emit("deal.keyed", payload, { tenantId: "t1" });
      await engine.emit("deal.keyed", payload, { tenantId: "t1" });
      expect(triggerEvents).toEqual([
        expect.objectContaining({ key: "event:keyed:deal.keyed/d1" }),
      ]);
    });
  });

  describe("window precedence", () => {
    const payload = { dealId: "d1", changes: [] };
    const emitKeyed = (window?: string | number) =>
      engine.emit("deal.keyed", payload, {
        tenantId: "t1",
        ...(window === undefined ? {} : { dedupe: { window } }),
      });

    it("the call's window beats the trigger's", async () => {
      await deploy(dealKeyedDoc("keyed")); // trigger window: 1h
      expect((await emitKeyed("1m")).started).toHaveLength(1);
      now += 60_000;
      expect((await emitKeyed("1m")).started).toHaveLength(1);
    });

    it("the trigger's window beats the engine default", async () => {
      observed({ dedupe: { defaultWindow: "1m" } });
      await deploy(dealKeyedDoc("keyed")); // trigger window: 1h
      expect((await emitKeyed()).started).toHaveLength(1);
      now += 3_600_000 - 1;
      expect((await emitKeyed()).started).toEqual([]);
      now += 1;
      expect((await emitKeyed()).started).toHaveLength(1);
    });

    it("without a call or trigger window, the engine default applies", async () => {
      observed({ dedupe: { defaultWindow: 120_000 } });
      await deploy(manualDoc("m"));
      const start = () =>
        engine.start({
          tenantId: "t1",
          workflowId: "m",
          input: { count: 1 },
          dedupe: { key: "k" },
        });
      const a = await start();
      now += 119_999;
      expect(await start()).toBe(a);
      now += 1;
      expect(await start()).not.toBe(a);
    });

    it("the engine default is 7 days", async () => {
      await deploy(manualDoc("m"));
      const start = () =>
        engine.start({
          tenantId: "t1",
          workflowId: "m",
          input: { count: 1 },
          dedupe: { key: "k" },
        });
      const a = await start();
      now += 7 * 86_400_000 - 1;
      expect(await start()).toBe(a);
      now += 1;
      expect(await start()).not.toBe(a);
    });

    it.each([0, "-1s", "nope"])(
      "rejects a call window of %j with FlowlineValidationError",
      async (window) => {
        await deploy(manualDoc("m"));
        await deploy(eventDoc("on-signup", "user.signedUp"));
        await expect(
          engine.emit("user.signedUp", {}, { tenantId: "t1", dedupe: { key: "k", window } }),
        ).rejects.toBeInstanceOf(FlowlineValidationError);
        await expect(
          engine.start({
            tenantId: "t1",
            workflowId: "m",
            input: { count: 1 },
            dedupe: { window },
          }),
        ).rejects.toBeInstanceOf(FlowlineValidationError);
        expect(await storage.listRuns("t1", {})).toEqual([]);
      },
    );

    it.each([0, "-1s", "nope"])(
      "rejects an engine default of %j with FlowlineDefinitionError",
      (defaultWindow) => {
        expect(() => createEngine({ registry, storage, dedupe: { defaultWindow } })).toThrow(
          FlowlineDefinitionError,
        );
      },
    );
  });

  it("a storage failure launching one match rejects that match only; the others start", async () => {
    const failing: StorageAdapter = Object.create(storage);
    failing.createRun = async (run, events, at) => {
      if (run.workflowId === "b") throw new Error("connection reset");
      return storage.createRun(run, events, at);
    };
    const { triggerEvents } = observed({ storage: failing });
    await deploy(eventDoc("a", "user.signedUp"));
    await deploy(eventDoc("b", "user.signedUp"));
    await deploy(eventDoc("c", "user.signedUp"));
    const result = await engine.emit("user.signedUp", {}, { tenantId: "t1" });
    expect(result.started).toHaveLength(2);
    const workflows = await Promise.all(
      result.started.map(async (id) => (await storage.getRun("t1", id))?.workflowId),
    );
    expect(workflows).toEqual(["a", "c"]);
    expect(result.rejected).toEqual([
      { workflowId: "b", version: 1, message: "connection reset", issues: [] },
    ]);
    expect(triggerEvents).toEqual([
      expect.objectContaining({ type: "trigger.rejected", workflowId: "b", issues: [] }),
    ]);
  });
});
