import {
  type CallbackHandle,
  createRegistry,
  defineNode,
  definePlugin,
  defineTrigger,
  type NodeContext,
  type Step,
  suspend,
  type WorkflowDoc,
} from "@flowkit/core";
import { createMemoryStorage } from "@flowkit/storage-memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createEngine, type EngineOptions } from "./engine";
import { FatalError, RetryableError } from "./errors";
import { createExecutor } from "./executor";
import type { Lease, StorageAdapter } from "./storage";

const TENANT = "t1";

let calls: Record<string, number>;
let behaviours: Record<string, (ctx: NodeContext) => unknown>;

const registry = createRegistry([
  definePlugin({
    id: "t",
    name: "Test",
    triggers: [
      defineTrigger({ type: "t.manual", name: "Manual", kind: "manual", config: z.object({}) }),
    ],
    nodes: [
      defineNode({
        type: "t.node",
        name: "Node",
        input: z.object({ value: z.unknown().optional() }),
        run: ({ input, ctx }) => {
          calls[ctx.stepPath] = (calls[ctx.stepPath] ?? 0) + 1;
          const b = behaviours[ctx.stepId];
          return (b ? b(ctx) : { value: input.value }) as never;
        },
      }),
      defineNode({
        type: "t.quick",
        name: "Quick",
        input: z.object({}),
        timeoutMs: 40,
        run: ({ ctx }) => behaviours[ctx.stepId]?.(ctx) as never,
      }),
    ],
  }),
]);

let storage: StorageAdapter;
let now: number;
const clock = () => now;
let runSeq = 0;

const makeEngine = (extra: Partial<EngineOptions> = {}) =>
  createEngine({ registry, storage, clock, ...extra });

const step = (id: string, config: Step["config"] = {}): Step => ({ id, type: "t.node", config });

const wf = (steps: Step[], id = "wf"): WorkflowDoc => ({
  id,
  name: "Workflow",
  trigger: { type: "t.manual", config: {} },
  steps,
});

async function startRun(doc: WorkflowDoc, at = now): Promise<string> {
  const v = await storage.saveWorkflowVersion(TENANT, doc, "user", at);
  await storage.publishVersion(TENANT, doc.id, v.version, at);
  const id = `run-${++runSeq}`;
  await storage.createRun(
    {
      id,
      tenantId: TENANT,
      workflowId: doc.id,
      version: v.version,
      status: "queued",
      trigger: {},
      journal: {},
      attempt: 1,
      startedBy: { kind: "manual" },
    },
    [{ runId: id, tenantId: TENANT, type: "run.started", at }],
    at,
  );
  return id;
}

async function getRun(id: string) {
  const run = await storage.getRun(TENANT, id);
  if (!run) throw new Error("run missing");
  return run;
}

const eventsOf = (id: string) => storage.listEvents(TENANT, id);

/** A handler that waits for a callback and returns what it was resumed with. */
function waitForCallback(handles: CallbackHandle[], timeoutMs = 10_000) {
  return async (ctx: NodeContext) => {
    if (ctx.resume) return { resume: ctx.resume };
    const cb = await ctx.callback({ timeoutMs });
    handles.push(cb);
    return suspend({ callback: cb });
  };
}

beforeEach(() => {
  storage = createMemoryStorage();
  now = 1_000_000;
  calls = {};
  behaviours = {};
});

describe("timers", () => {
  it("suspends until the time, is not claimable before it, and completes after it", async () => {
    const seen: { resume: unknown; attempt: number }[] = [];
    behaviours.a = (ctx) => {
      seen.push({ resume: ctx.resume, attempt: ctx.attempt });
      return ctx.resume?.kind === "timer" ? { ok: true } : suspend({ until: ctx.now() + 60_000 });
    };
    const id = await startRun(wf([step("a"), step("b")]));
    const t0 = now;
    const engine = makeEngine();
    await engine.drain();

    let run = await getRun(id);
    expect(run).toMatchObject({
      status: "waiting",
      waitReason: "timer",
      wakeAt: t0 + 60_000,
      currentStep: "a",
    });
    expect(run.journal.a).toMatchObject({ status: "suspended", pending: { until: t0 + 60_000 } });
    expect(run.leaseOwner).toBeUndefined();

    now += 59_000;
    expect(await engine.runOnce()).toBe(false);
    now += 1_000;
    await engine.drain();

    run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(run.journal.a).toMatchObject({ status: "done", output: { ok: true } });
    expect(run.resume).toBeUndefined();
    expect(run.waitReason).toBeUndefined();
    // Waking a suspended run is not a lost worker: the attempt is not bumped.
    expect(seen).toEqual([
      { resume: undefined, attempt: 1 },
      { resume: { kind: "timer" }, attempt: 1 },
    ]);
    const types = (await eventsOf(id)).map((e) => e.type);
    expect(types).toEqual([
      "run.started",
      "step.started",
      "run.suspended",
      "run.resumed",
      "step.started",
      "step.completed",
      "step.started",
      "step.completed",
      "run.completed",
    ]);
    const events = await eventsOf(id);
    expect(events.find((e) => e.type === "run.suspended")?.data).toEqual({ until: t0 + 60_000 });
    expect(events.find((e) => e.type === "run.resumed")?.data).toEqual({ kind: "timer" });
  });

  it("persists the timer resume in the start commit so a lost worker's retry still sees it", async () => {
    const seen: { resume: unknown; attempt: number }[] = [];
    behaviours.a = (ctx) => {
      seen.push({ resume: ctx.resume, attempt: ctx.attempt });
      return ctx.resume ? { ok: true } : suspend({ until: ctx.now() + 1000 });
    };
    const id = await startRun(wf([step("a")]));
    let crashed = false;
    const engine = makeEngine({
      leaseMs: 100,
      __testHooks: {
        beforeCommit(_runId, stepPath, phase) {
          if (stepPath === "a" && phase === "result" && seen.length === 2 && !crashed) {
            crashed = true;
            throw new Error("crash");
          }
        },
      },
    });
    await engine.drain();
    now += 1000;
    await expect(engine.runOnce()).rejects.toThrow("crash");
    now += 200;
    await engine.drain();
    expect((await getRun(id)).status).toBe("completed");
    expect(seen).toEqual([
      { resume: undefined, attempt: 1 },
      { resume: { kind: "timer" }, attempt: 1 },
      { resume: { kind: "timer" }, attempt: 2 },
    ]);
    const resumed = (await eventsOf(id)).filter((e) => e.type === "run.resumed");
    expect(resumed).toHaveLength(1);
  });
});

describe("callbacks", () => {
  it("resumes with the body exactly once and builds the resume URL", async () => {
    const handles: CallbackHandle[] = [];
    behaviours.a = waitForCallback(handles);
    const id = await startRun(wf([step("a")]));
    const t0 = now;
    const engine = makeEngine({ publicUrl: "https://app.test", basePath: "/wf" });
    await engine.drain();

    const cb = handles[0]!;
    expect(cb.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cb.resumeUrl).toBe(`https://app.test/wf/resume/${cb.token}`);
    expect(cb.expiresAt).toBe(t0 + 10_000);
    let run = await getRun(id);
    expect(run).toMatchObject({
      status: "waiting",
      waitReason: "callback",
      wakeAt: t0 + 10_000,
      callbackToken: cb.token,
      callbackExpiresAt: t0 + 10_000,
    });
    expect(run.journal.a).toMatchObject({
      status: "suspended",
      pending: { hasCallback: true, expiresAt: t0 + 10_000 },
    });

    expect(await engine.resume(cb.token, { approved: true })).toBe("resumed");
    expect(await engine.resume(cb.token, { approved: false })).toBe("gone");
    await engine.drain();

    run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(run.journal.a).toMatchObject({
      status: "done",
      output: { resume: { kind: "callback", body: { approved: true } } },
    });
    const events = await eventsOf(id);
    expect(events.find((e) => e.type === "run.suspended")?.data).toEqual({
      callback: true,
      expiresAt: t0 + 10_000,
    });
    expect(events.filter((e) => e.type === "run.resumed").map((e) => e.data)).toEqual([
      { kind: "callback" },
    ]);
  });

  it("defaults the resume URL to the base path", async () => {
    const handles: CallbackHandle[] = [];
    behaviours.a = waitForCallback(handles);
    await startRun(wf([step("a")]));
    await makeEngine().drain();
    expect(handles[0]?.resumeUrl).toBe(`/flowkit/resume/${handles[0]?.token}`);
  });

  it("wakes with a timeout when the callback expires, and the token stops working", async () => {
    const handles: CallbackHandle[] = [];
    behaviours.a = waitForCallback(handles);
    const id = await startRun(wf([step("a")]));
    const engine = makeEngine();
    await engine.drain();
    now += 9_999;
    expect(await engine.runOnce()).toBe(false);
    now += 1;
    await engine.drain();

    const run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(run.journal.a).toMatchObject({ output: { resume: { kind: "timeout" } } });
    expect(run.callbackToken).toBeUndefined();
    expect(run.callbackExpiresAt).toBeUndefined();
    expect(await engine.resume(handles[0]!.token, {})).toBe("gone");
    const resumed = (await eventsOf(id)).filter((e) => e.type === "run.resumed");
    expect(resumed.map((e) => e.data)).toEqual([{ kind: "timeout" }]);
  });

  it("keeps the callback resume across a retry without issuing a second callback", async () => {
    const seen: unknown[] = [];
    let callbacks = 0;
    let thrown = false;
    behaviours.a = async (ctx) => {
      seen.push(ctx.resume);
      if (ctx.resume) {
        if (!thrown) {
          thrown = true;
          throw new Error("flaky");
        }
        return { ok: true };
      }
      callbacks++;
      return suspend({ callback: await ctx.callback({ timeoutMs: 60_000 }) });
    };
    const id = await startRun(wf([step("a")]));
    const engine = makeEngine();
    await engine.drain();
    const token = (await getRun(id)).callbackToken!;
    expect(await engine.resume(token, { n: 1 })).toBe("resumed");
    await engine.drain();
    expect(await getRun(id)).toMatchObject({ status: "waiting", waitReason: "retry" });
    now += 1000;
    await engine.drain();

    expect((await getRun(id)).status).toBe("completed");
    const resume = { kind: "callback", body: { n: 1 } };
    expect(seen).toEqual([undefined, resume, resume]);
    expect(callbacks).toBe(1);
    const resumed = (await eventsOf(id)).filter((e) => e.type === "run.resumed");
    expect(resumed).toHaveLength(1);
  });

  it("never writes the token into the journal or events", async () => {
    const handles: CallbackHandle[] = [];
    behaviours.a = waitForCallback(handles);
    const id = await startRun(wf([step("a")]));
    const engine = makeEngine();
    await engine.drain();
    const token = handles[0]!.token;
    const pieces = [token, token.slice(0, 12), token.slice(-12), handles[0]!.resumeUrl];
    const check = async () => {
      const run = await getRun(id);
      const text = JSON.stringify({ journal: run.journal, events: await eventsOf(id) });
      for (const p of pieces) expect(text).not.toContain(p);
    };
    await check();
    await engine.resume(token, { ok: 1 });
    await engine.drain();
    await check();
  });

  it("fails fatally when suspending on a callback handle this invocation did not create", async () => {
    behaviours.a = () =>
      suspend({ callback: { token: "forged", resumeUrl: "/x", expiresAt: now + 1 } });
    const id = await startRun(wf([step("a")]));
    await makeEngine().drain();
    const run = await getRun(id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({ fatal: true, stepPath: "a" });
    expect(run.callbackToken).toBeUndefined();
  });

  it("fails fatally when a step issues a second callback", async () => {
    behaviours.a = async (ctx) => {
      await ctx.callback({ timeoutMs: 1000 });
      return suspend({ callback: await ctx.callback({ timeoutMs: 1000 }) });
    };
    const id = await startRun(wf([step("a")]));
    await makeEngine().drain();
    const run = await getRun(id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({
      message: "callback already issued for this step",
      fatal: true,
      stepPath: "a",
    });
    expect(run.callbackToken).toBeUndefined();
  });
});

describe("resumeRun", () => {
  it("resumes a callback-waiting run without the token, recording who resumed it", async () => {
    const handles: CallbackHandle[] = [];
    behaviours.a = waitForCallback(handles);
    const id = await startRun(wf([step("a")]));
    const engine = makeEngine();
    await engine.drain();

    expect(await engine.resumeRun("other-tenant", id, { x: 1 }, "u1")).toBe("gone");
    expect(await engine.resumeRun(TENANT, "missing", { x: 1 }, "u1")).toBe("gone");
    expect(await engine.resumeRun(TENANT, id, { x: 1 }, "u1")).toBe("resumed");
    expect(await engine.resumeRun(TENANT, id, { x: 2 }, "u1")).toBe("gone");
    expect(await engine.resume(handles[0]!.token, {})).toBe("gone");
    await engine.drain();

    const run = await getRun(id);
    expect(run.journal.a).toMatchObject({
      output: { resume: { kind: "callback", body: { x: 1 } } },
    });
    const resumed = (await eventsOf(id)).filter((e) => e.type === "run.resumed");
    expect(resumed.map((e) => e.data)).toEqual([{ kind: "callback", by: "u1" }]);
  });

  it("does not resume a timer-waiting run", async () => {
    behaviours.a = (ctx) => (ctx.resume ? {} : suspend({ until: ctx.now() + 1000 }));
    const id = await startRun(wf([step("a")]));
    const engine = makeEngine();
    await engine.drain();
    expect(await engine.resumeRun(TENANT, id, {}, "u1")).toBe("gone");
  });
});

describe("lease renewal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renews the lease of a handler running 3x leaseMs so no other worker can claim it", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    let started!: () => void;
    const inFlight = new Promise<void>((r) => {
      started = r;
    });
    behaviours.a = () => {
      started();
      return new Promise((r) => setTimeout(() => r({ ok: true }), 3000));
    };
    const id = await startRun(wf([step("a")]), Date.now());
    const engine = createEngine({ registry, storage, leaseMs: 1000 });
    const done = engine.runOnce("w1");
    await inFlight;
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(500);
      expect(await storage.claimRun({ workerId: "w2", leaseMs: 1000, now: Date.now() })).toBe(null);
    }
    await done;
    expect((await getRun(id)).status).toBe("completed");
    expect(calls.a).toBe(1);
  });
});

describe("retryRun", () => {
  it("continues a failed run from the failed step", async () => {
    let fixed = false;
    behaviours.b = () => {
      if (!fixed) throw new FatalError("broken");
      return { ok: true };
    };
    const id = await startRun(wf([step("a"), step("b"), step("c")]));
    const engine = makeEngine();
    await engine.drain();
    expect((await getRun(id)).status).toBe("failed");

    fixed = true;
    expect(await engine.retryRun(TENANT, id)).toBe(id);
    const queued = await getRun(id);
    expect(queued).toMatchObject({ status: "queued", attempt: 1 });
    expect(queued.error).toBeUndefined();
    expect(queued.journal.b).toBeUndefined();
    expect(queued.journal.a?.status).toBe("done");
    await engine.drain();

    expect((await getRun(id)).status).toBe("completed");
    expect(calls).toEqual({ a: 1, b: 2, c: 1 });
    const resumed = (await eventsOf(id)).filter((e) => e.type === "run.resumed");
    expect(resumed.map((e) => e.data)).toEqual([{ retry: true }]);
  });

  it("rejects runs that are not failed", async () => {
    const id = await startRun(wf([step("a")]));
    const engine = makeEngine();
    await expect(engine.retryRun(TENANT, id)).rejects.toThrow(/not failed/);
    await expect(engine.retryRun("other", id)).rejects.toThrow(/not found/);
  });
});

describe("cancelRun", () => {
  it("cancels a waiting run and invalidates its callback", async () => {
    const handles: CallbackHandle[] = [];
    behaviours.a = waitForCallback(handles);
    const id = await startRun(wf([step("a")]));
    const engine = makeEngine();
    await engine.drain();

    expect(await engine.cancelRun(TENANT, id)).toBe("cancelled");
    const run = await getRun(id);
    expect(run.status).toBe("cancelled");
    expect(run.callbackToken).toBeUndefined();
    expect(run.wakeAt).toBeUndefined();
    expect(await engine.resume(handles[0]!.token, {})).toBe("gone");
    now += 20_000;
    expect(await engine.runOnce()).toBe(false);
    expect((await eventsOf(id)).at(-1)?.type).toBe("run.cancelled");
    // Cancelling again is a no-op.
    expect(await engine.cancelRun(TENANT, id)).toBe("finished");
    expect((await eventsOf(id)).filter((e) => e.type === "run.cancelled")).toHaveLength(1);
  });

  it("rejects unknown runs", async () => {
    await expect(makeEngine().cancelRun(TENANT, "missing")).rejects.toThrow(/not found/);
    const id = await startRun(wf([step("a")]));
    await expect(makeEngine().cancelRun("other", id)).rejects.toThrow(/not found/);
  });

  it("aborts a long-running handler: the signal fires, the run is cancelled, no later step runs", async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => {
      started = r;
    });
    let abortReason: unknown;
    behaviours.a = (ctx) =>
      new Promise((_, reject) => {
        started();
        ctx.signal.addEventListener("abort", () => {
          abortReason = ctx.signal.reason;
          reject(new Error("aborted by signal"));
        });
      });
    const id = await startRun(wf([step("a"), step("b")]));
    // Real renewal ticks every 20 ms; the fake clock stands still, so the lease stays live.
    const engine = makeEngine({ leaseMs: 40 });
    const claim = engine.runOnce();
    await running;

    expect(await engine.cancelRun(TENANT, id)).toBe("requested");
    expect((await getRun(id)).status).toBe("running");
    await claim;

    const run = await getRun(id);
    expect(run.status).toBe("cancelled");
    expect(run.leaseOwner).toBeUndefined();
    expect(abortReason).toBeInstanceOf(Error);
    expect((abortReason as Error).message).toBe("run cancelled");
    expect(calls).toEqual({ a: 1 });
    expect(run.journal.a).toBeUndefined();
    const events = await eventsOf(id);
    expect(events.at(-1)).toMatchObject({ type: "run.cancelled", stepPath: "a" });
    expect(events.filter((e) => e.type === "run.cancelled")).toHaveLength(1);
    expect(await engine.runOnce()).toBe(false);
  });

  it("cancels between steps once the current step committed", async () => {
    let result: string | undefined;
    const engine: ReturnType<typeof makeEngine> = makeEngine({
      __testHooks: {
        async beforeCommit(_runId, stepPath, phase) {
          if (stepPath === "a" && phase === "result" && result === undefined) {
            result = await engine.cancelRun(TENANT, id);
          }
        },
      },
    });
    const id = await startRun(wf([step("a"), step("b")]));
    await engine.drain();
    expect(result).toBe("requested");
    const run = await getRun(id);
    expect(run.status).toBe("cancelled");
    expect(run.journal.a?.status).toBe("done");
    expect(run.journal.b).toBeUndefined();
    expect(calls).toEqual({ a: 1 });
    expect((await eventsOf(id)).map((e) => e.type)).toEqual([
      "run.started",
      "step.started",
      "step.completed",
      "run.cancelled",
    ]);
  });

  it("cancels instead of suspending when the request arrives while the step runs", async () => {
    behaviours.a = (ctx) => suspend({ until: ctx.now() + 60_000 });
    let result: string | undefined;
    const engine: ReturnType<typeof makeEngine> = makeEngine({
      __testHooks: {
        async beforeCommit(_runId, stepPath, phase) {
          if (stepPath === "a" && phase === "start") result = await engine.cancelRun(TENANT, id);
        },
      },
    });
    const id = await startRun(wf([step("a")]));
    await engine.drain();
    expect(result).toBe("requested");
    const run = await getRun(id);
    expect(run.status).toBe("cancelled");
    expect(run.wakeAt).toBeUndefined();
    expect(run.journal.a).toBeUndefined();
    expect((await eventsOf(id)).some((e) => e.type === "run.suspended")).toBe(false);
  });

  it.each([
    [
      "a timer suspend",
      "run.suspended",
      (ctx: NodeContext) => suspend({ until: ctx.now() + 1000 }),
    ],
    [
      "a callback suspend",
      "run.suspended",
      async (ctx: NodeContext) => suspend({ callback: await ctx.callback({ timeoutMs: 1000 }) }),
    ],
    [
      "a retry wait",
      "step.retrying",
      () => {
        throw new Error("flaky");
      },
    ],
  ])(
    "cancels the run right after %s when the request lands just before the park",
    async (_name, parkEvent, behaviour) => {
      behaviours.a = behaviour;
      let armed = true;
      const id = await startRun(wf([step("a"), step("b")]));
      const engine = makeEngine({
        __testHooks: {
          async beforeCommit(runId, stepPath, phase) {
            // After the executor's pre-park check, while it still holds the lease.
            if (armed && stepPath === "a" && phase === "result") {
              armed = false;
              expect(await storage.requestCancel(TENANT, runId, now)).toBe(true);
            }
          },
        },
      });
      expect(await engine.runOnce()).toBe(true);
      const run = await getRun(id);
      expect(run.status).toBe("cancelled");
      expect(run.leaseOwner).toBeUndefined();
      expect(run.wakeAt).toBeUndefined();
      expect(run.callbackToken).toBeUndefined();
      expect((await eventsOf(id)).map((e) => e.type).slice(-2)).toEqual([
        parkEvent,
        "run.cancelled",
      ]);
      now += 60_000;
      expect(await engine.runOnce()).toBe(false);
      expect(calls).toEqual({ a: 1 });
    },
  );

  it("cancels at once when the worker parks the run between the failed CAS and the request", async () => {
    behaviours.a = (ctx) => suspend({ until: ctx.now() + 60_000 });
    const id = await startRun(wf([step("a")]));
    await makeEngine().drain();
    expect((await getRun(id)).status).toBe("waiting");
    // The first CAS loses as if the worker still held the lease; by the request it has parked.
    const base = storage;
    let casCalls = 0;
    storage = {
      ...base,
      async updateRunUnleased(...args) {
        return ++casCalls === 1 ? false : base.updateRunUnleased(...args);
      },
    };
    expect(await makeEngine().cancelRun(TENANT, id)).toBe("cancelled");
    expect(casCalls).toBe(2);
    const run = await getRun(id);
    expect(run.status).toBe("cancelled");
    expect(run.cancelRequestedAt).toBe(now);
    expect((await eventsOf(id)).filter((e) => e.type === "run.cancelled")).toHaveLength(1);
  });

  it("cancels a flagged run right after it is claimed", async () => {
    const id = await startRun(wf([step("a")]));
    expect(await storage.requestCancel(TENANT, id, now)).toBe(true);
    const engine = makeEngine();
    expect(await engine.runOnce()).toBe(true);
    const run = await getRun(id);
    expect(run.status).toBe("cancelled");
    expect(calls).toEqual({});
    expect((await eventsOf(id)).map((e) => e.type)).toEqual(["run.started", "run.cancelled"]);
  });
});

describe("suspend afterCommit", () => {
  /** A step that parks on a timer with `hook` as its afterCommit, recording the run at each call. */
  function parkWith(hook: () => Promise<void>) {
    const seen: unknown[] = [];
    behaviours.s = (ctx) => {
      if (ctx.resume) return { resumed: true };
      return suspend({
        until: now + 5000,
        afterCommit: async () => {
          const run = await storage.getRunById(ctx.runId);
          seen.push({ status: run?.status, waitReason: run?.waitReason });
          await hook();
        },
      });
    };
    return seen;
  }

  it("runs after the park commit of a timer suspension, and is never journaled", async () => {
    const seen = parkWith(async () => {});
    const id = await startRun(wf([step("s")]));
    await makeEngine().drain();
    expect(seen).toEqual([{ status: "waiting", waitReason: "timer" }]);
    const run = await getRun(id);
    expect(JSON.stringify([run.journal, await eventsOf(id)])).not.toContain("afterCommit");
    now += 5000;
    await makeEngine().drain();
    expect((await getRun(id)).status).toBe("completed");
    expect(seen).toHaveLength(1);
  });

  it("retries a RetryableError inline, at most 3 tries", async () => {
    let failures = 2;
    const seen = parkWith(async () => {
      if (failures-- > 0) throw new RetryableError("flaky");
    });
    const id = await startRun(wf([step("s")]));
    await makeEngine().drain();
    expect(seen).toHaveLength(3);
    expect((await eventsOf(id)).map((e) => e.type)).not.toContain("step.notifyFailed");
  });

  it("records step.notifyFailed for any other error without retrying, and keeps waiting", async () => {
    const warnings: unknown[] = [];
    const seen = parkWith(async () => {
      throw new Error("receiver said no");
    });
    const id = await startRun(wf([step("s")]));
    await makeEngine({
      logger: {
        debug() {},
        info() {},
        warn: (msg, meta) => warnings.push({ msg, meta }),
        error() {},
      },
    }).drain();
    expect(seen).toHaveLength(1);
    expect(await getRun(id)).toMatchObject({ status: "waiting", waitReason: "timer" });
    const failed = (await eventsOf(id)).filter((e) => e.type === "step.notifyFailed");
    expect(failed).toEqual([
      expect.objectContaining({
        stepPath: "s",
        data: { error: { message: "receiver said no" }, attempts: 1 },
      }),
    ]);
    expect(warnings).toContainEqual(expect.objectContaining({ msg: "after-commit hook failed" }));
  });

  it("masks the callback's token and URL in the recorded error", async () => {
    behaviours.s = async (ctx) => {
      const cb = await ctx.callback({ timeoutMs: 10_000 });
      return suspend({
        callback: cb,
        afterCommit: async () => {
          throw new Error(`could not deliver ${cb.resumeUrl} (token ${cb.token})`);
        },
      });
    };
    const id = await startRun(wf([step("s")]));
    await makeEngine().drain();
    const token = (await getRun(id)).callbackToken as string;
    const events = await eventsOf(id);
    expect(JSON.stringify(events)).not.toContain(token);
    expect(events.find((e) => e.type === "step.notifyFailed")?.data).toEqual({
      error: { message: "could not deliver [redacted] (token [redacted])" },
      attempts: 1,
    });
  });

  it("records attempts: 3 when every try fails retryably", async () => {
    parkWith(async () => {
      throw new RetryableError("still down");
    });
    const id = await startRun(wf([step("s")]));
    await makeEngine().drain();
    expect((await eventsOf(id)).find((e) => e.type === "step.notifyFailed")?.data).toEqual({
      error: { message: "still down" },
      attempts: 3,
    });
  });

  /** Step `stepId`'s afterCommit never settles; returns the signals it got. */
  function hangingHook(stepId = "q") {
    const signals: AbortSignal[] = [];
    behaviours[stepId] = () =>
      suspend({
        until: now + 5000,
        afterCommit: ({ signal }) => {
          signals.push(signal);
          return new Promise<void>(() => {});
        },
      });
    return signals;
  }
  /** A t.quick step: its timeoutMs of 40 bounds each afterCommit try. */
  const quick: Step = { id: "q", type: "t.quick", config: {} };

  it("times out a hook that never settles, aborting its signal, and records the failure", async () => {
    const signals = hangingHook();
    const id = await startRun(wf([quick]));
    await makeEngine().drain();
    expect(signals).toHaveLength(3);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(await getRun(id)).toMatchObject({ status: "waiting", waitReason: "timer" });
    expect((await eventsOf(id)).find((e) => e.type === "step.notifyFailed")?.data).toEqual({
      error: { message: "afterCommit timed out after 40ms" },
      attempts: 3,
    });
  });

  it("aborts the hook when the worker stops", async () => {
    // A t.node step: no timeoutMs, so only the stop can end the 30 s try.
    const signals = hangingHook("s");
    const id = await startRun(wf([step("s")]));
    const executor = createExecutor({ registry, storage, clock });
    const lease = await storage.claimRun({ workerId: "w1", leaseMs: 30_000, now });
    const stop = new AbortController();
    const done = executor.executeClaim(lease as Lease, "w1", stop.signal);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    stop.abort();
    await done;
    expect(signals[0]?.aborted).toBe(true);
    expect(signals).toHaveLength(1);
    expect((await eventsOf(id)).find((e) => e.type === "step.notifyFailed")?.data).toEqual({
      error: { message: "worker stopped" },
      attempts: 1,
    });
  });

  it("stops retrying once the run no longer waits on this suspension", async () => {
    let engine: ReturnType<typeof makeEngine> | undefined;
    let tries = 0;
    behaviours.s = async (ctx) => {
      if (ctx.resume) return { resumed: true };
      const cb = await ctx.callback({ timeoutMs: 10_000 });
      return suspend({
        callback: cb,
        afterCommit: async () => {
          tries++;
          // The receiver resumes the run before answering the notification with an error.
          await engine?.resume(cb.token, { ok: true });
          throw new RetryableError("502 after resuming");
        },
      });
    };
    engine = makeEngine();
    const id = await startRun(wf([step("s")]));
    await engine.drain();
    expect(tries).toBe(1);
    expect((await getRun(id)).status).toBe("completed");
    expect((await eventsOf(id)).map((e) => e.type)).not.toContain("step.notifyFailed");
  });
});
