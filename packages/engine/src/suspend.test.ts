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
import { FatalError } from "./errors";
import type { StorageAdapter } from "./storage";

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

    await engine.cancelRun(TENANT, id);
    const run = await getRun(id);
    expect(run.status).toBe("cancelled");
    expect(run.callbackToken).toBeUndefined();
    expect(run.wakeAt).toBeUndefined();
    expect(await engine.resume(handles[0]!.token, {})).toBe("gone");
    now += 20_000;
    expect(await engine.runOnce()).toBe(false);
    expect((await eventsOf(id)).at(-1)?.type).toBe("run.cancelled");
    // Cancelling again is a no-op.
    await engine.cancelRun(TENANT, id);
    expect((await eventsOf(id)).filter((e) => e.type === "run.cancelled")).toHaveLength(1);
  });

  it("rejects unknown runs", async () => {
    await expect(makeEngine().cancelRun(TENANT, "missing")).rejects.toThrow(/not found/);
  });
});
