import {
  createRegistry,
  defineNode,
  definePlugin,
  defineTrigger,
  FlowlineDefinitionError,
  type PollArgs,
  type PollResult,
  type WorkflowDoc,
} from "@flowlinejs/core";
import { createMemoryStorage } from "@flowlinejs/storage-memory";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { z } from "zod";
import { createEngine, type Engine, type EngineOptions } from "./engine";
import type { PollLease, PollPatch, StorageAdapter } from "./storage";
import type { TriggerEvent } from "./trigger-events";

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

type Payload = { id: string };
type Call = { since: number; until: number; cursor: unknown };

let now: number;
let calls: Call[];
let lastArgs: PollArgs<Record<string, unknown>> | undefined;
/** What the next `poll` call does; `n` is its 1-based number. */
let pollImpl: (
  args: PollArgs<Record<string, unknown>>,
  n: number,
) => Promise<PollResult<Payload>> | PollResult<Payload>;

const due = defineTrigger({
  type: "p.due",
  name: "Due",
  kind: "poll",
  interval: "1m",
  maxInterval: "24h",
  config: z.object({ label: z.string().default("x") }),
  payload: z.object({ id: z.string() }),
  poll: (args) => {
    calls.push({ since: args.since, until: args.until, cursor: args.cursor });
    lastArgs = args;
    return pollImpl(args, calls.length);
  },
});
const echo = defineNode({
  type: "p.echo",
  name: "Echo",
  input: z.object({ value: z.unknown() }),
  run: ({ input }) => ({ value: input.value }),
});
const registry = createRegistry([
  definePlugin({ id: "p", name: "P", nodes: [echo], triggers: [due] }),
]);

const doc: WorkflowDoc = {
  id: "wf",
  name: "wf",
  trigger: { type: "p.due", config: { label: "hello" } },
  steps: [{ id: "e", type: "p.echo", config: { value: { $ref: "trigger.id" } } }],
};

let storage: StorageAdapter;
let events: TriggerEvent[];
let warn: Mock<(message: string, data?: unknown) => void>;
let engine: Engine;

const newEngine = (extra: Partial<EngineOptions> = {}) =>
  createEngine({
    registry,
    storage,
    clock: () => now,
    services: { tag: "svc" } as never,
    logger: { debug: () => {}, info: () => {}, warn, error: () => {} },
    onTriggerEvent: (e) => events.push(e),
    ...extra,
  });

async function deploy(e: Engine = engine) {
  const v = await e.saveWorkflow("t1", doc, "u");
  await e.publish("t1", "wf", v.version, "u");
}

const state = () => storage.getPollState("t1", "wf");
/** The poll item key a run was started for. */
async function itemKeyOf(runId: string): Promise<string> {
  const origin = (await storage.getRun("t1", runId))?.startedBy;
  if (origin?.kind !== "poll") throw new Error(`run ${runId} was not started by a poll`);
  return origin.itemKey;
}
const ofType = <T extends TriggerEvent["type"]>(type: T) =>
  events.filter((e): e is Extract<TriggerEvent, { type: T }> => e.type === type);
const empty = (): PollResult<Payload> => ({ items: [] });
/** Each call's cursor is `c<n>`. */
const counting = (_: unknown, n: number): PollResult<Payload> => ({ items: [], cursor: `c${n}` });
const item = (key: string, id: unknown = key) => ({ key, payload: { id } as Payload });

/** Asserts that `cs` form a contiguous chain `(since, until]`, each starting at the last's end. */
function expectContiguous(cs: Call[]) {
  for (let i = 1; i < cs.length; i++) expect(cs[i]?.since).toBe(cs[i - 1]?.until);
}

beforeEach(async () => {
  storage = createMemoryStorage();
  events = [];
  warn = vi.fn<(message: string, data?: unknown) => void>();
  calls = [];
  lastArgs = undefined;
  pollImpl = empty;
  now = T0;
  engine = newEngine();
  await deploy(); // published at T0
});

describe("createEngine poll options", () => {
  it("rejects invalid poll options with FlowlineDefinitionError", () => {
    for (const poll of [
      { maxCallsPerTick: 0 },
      { maxCallsPerTick: 1.5 },
      { maxCallsPerTick: -1 },
      { leaseMs: 0 },
      { defaultInterval: "soon" },
      { defaultMaxInterval: 0 },
      { defaultInterval: "2h", defaultMaxInterval: "1h" },
    ]) {
      expect(() => createEngine({ registry, storage, poll })).toThrow(FlowlineDefinitionError);
    }
    expect(() =>
      createEngine({ registry, storage, poll: { maxCallsPerTick: 3, leaseMs: 1000 } }),
    ).not.toThrow();
  });
});

describe("tickPolls", () => {
  it("polls (publishedAt, now] first, then advances since and schedules nextAt", async () => {
    now = T0 + 5 * MIN;
    pollImpl = () => ({ items: [item("a"), item("b")], cursor: { page: 2 } });
    expect(await engine.tickPolls()).toBe(2);
    expect(calls).toEqual([{ since: T0, until: now, cursor: null }]);
    expect(lastArgs?.config).toEqual({ label: "hello" });
    expect(lastArgs?.ctx).toMatchObject({
      tenantId: "t1",
      workflowId: "wf",
      services: { tag: "svc" },
    });
    expect(lastArgs?.ctx.signal.aborted).toBe(false);

    const s = await state();
    expect(s).toMatchObject({ since: now, cursor: { page: 2 }, nextAt: now + MIN });
    expect(s?.lastError).toBeUndefined();
    expect(s?.leaseOwner).toBeUndefined();
    expect(ofType("poll.completed")).toEqual([
      {
        type: "poll.completed",
        at: now,
        tenantId: "t1",
        workflowId: "wf",
        since: T0,
        until: now,
        items: 2,
        started: 2,
        rejected: 0,
      },
    ]);
  });

  it("catches up a 3-day gap in four chunks under one lease, passing each cursor on", async () => {
    now = T0 + 3 * DAY + 5 * MIN;
    const claims: unknown[] = [];
    pollImpl = async (_, n) => {
      claims.push(
        await storage.claimPoll("t1", "wf", { workerId: "other", leaseMs: MIN, now: now + 1 }),
      );
      return { items: [], cursor: `c${n}` };
    };
    await engine.tickPolls();
    expect(calls).toEqual([
      { since: T0, until: T0 + DAY, cursor: null },
      { since: T0 + DAY, until: T0 + 2 * DAY, cursor: "c1" },
      { since: T0 + 2 * DAY, until: T0 + 3 * DAY, cursor: "c2" },
      { since: T0 + 3 * DAY, until: now, cursor: "c3" },
    ]);
    expect(claims).toEqual([null, null, null, null]);
    expect(await state()).toMatchObject({ since: now, cursor: "c4", nextAt: now + MIN });
    expect(ofType("poll.completed")).toHaveLength(4);
  });

  it("stops a 30-day backlog after maxCallsPerTick calls and resumes it on the next tick", async () => {
    now = T0 + 30 * DAY;
    pollImpl = counting;
    await engine.tickPolls();
    expect(calls).toHaveLength(10);
    expect(calls[0]?.since).toBe(T0);
    expect(calls[9]?.until).toBe(T0 + 10 * DAY);
    expect(await state()).toMatchObject({ since: T0 + 10 * DAY, nextAt: now, cursor: "c10" });
    expect((await state())?.leaseOwner).toBeUndefined();

    await engine.tickPolls();
    expect(calls).toHaveLength(20);
    expect(calls[10]).toEqual({ since: T0 + 10 * DAY, until: T0 + 11 * DAY, cursor: "c10" });
    expect(calls[19]?.until).toBe(T0 + 20 * DAY);
    expectContiguous(calls);
    for (const c of calls) expect(c.until - c.since).toBe(DAY);
    expect(await state()).toMatchObject({ since: T0 + 20 * DAY, nextAt: now });
  });

  it("covers a gap of exactly maxInterval in one call", async () => {
    now = T0 + DAY;
    await engine.tickPolls();
    expect(calls).toEqual([{ since: T0, until: T0 + DAY, cursor: null }]);
    expect((await state())?.nextAt).toBe(T0 + DAY + MIN);
  });

  it("keeps earlier chunks when a later chunk of a chain throws", async () => {
    now = T0 + 3 * DAY + 5 * MIN;
    pollImpl = (_, n) => {
      if (n === 2) throw new Error("upstream down");
      return { items: [], cursor: `c${n}` };
    };
    await engine.tickPolls();
    expect(calls).toHaveLength(2);
    const s = await state();
    expect(s).toMatchObject({
      since: T0 + DAY,
      cursor: "c1",
      nextAt: now + MIN,
      lastError: "upstream down",
    });
    expect(s?.leaseOwner).toBeUndefined();
    expect(ofType("poll.failed")).toEqual([
      {
        type: "poll.failed",
        at: now,
        tenantId: "t1",
        workflowId: "wf",
        since: T0 + DAY,
        until: T0 + 2 * DAY,
        message: "upstream down",
        nextAt: now + MIN,
      },
    ]);

    now += MIN;
    pollImpl = counting;
    await engine.tickPolls();
    expect(calls[2]).toEqual({ since: T0 + DAY, until: T0 + 2 * DAY, cursor: "c1" });
    expect(calls.at(-1)?.until).toBe(now);
    expect((await state())?.lastError).toBeUndefined();
  });

  it("makes one call per tick with maxCallsPerTick 1, nextAt = now while behind", async () => {
    engine = newEngine({ poll: { maxCallsPerTick: 1 } });
    now = T0 + 3 * DAY + 5 * MIN;
    for (let tick = 1; tick <= 3; tick++) {
      await engine.tickPolls();
      expect(calls).toHaveLength(tick);
      expect(await state()).toMatchObject({ since: T0 + tick * DAY, nextAt: now });
    }
    await engine.tickPolls();
    expect(calls).toHaveLength(4);
    expect(await state()).toMatchObject({ since: now, nextAt: now + MIN });
    expectContiguous(calls);
  });

  it("polls only once nextAt is reached", async () => {
    now = T0 + 5 * MIN;
    await engine.tickPolls();
    expect(calls).toHaveLength(1);
    now += MIN - 1;
    expect(await engine.tickPolls()).toBe(0);
    expect(calls).toHaveLength(1);
    now += 1; // nextAt === now
    await engine.tickPolls();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ since: T0 + 5 * MIN, until: now, cursor: null });
  });

  it("polls once when two engines tick concurrently, with contiguous intervals", async () => {
    const other = newEngine();
    for (let tick = 1; tick <= 5; tick++) {
      now = T0 + tick * MIN;
      await Promise.all([engine.tickPolls(), other.tickPolls()]);
      expect(calls).toHaveLength(tick);
    }
    expect(calls[0]?.since).toBe(T0);
    expectContiguous(calls);
    expect(calls.at(-1)?.until).toBe(T0 + 5 * MIN);
  });

  it("keeps since and cursor when a poll throws, and re-covers the interval next tick", async () => {
    now = T0 + 5 * MIN;
    pollImpl = () => {
      throw new Error("rate limited");
    };
    expect(await engine.tickPolls()).toBe(0);
    const s = await state();
    expect(s).toMatchObject({
      since: null,
      cursor: null,
      nextAt: now + MIN,
      lastError: "rate limited",
    });
    expect(ofType("poll.failed")).toMatchObject([
      { since: T0, until: now, message: "rate limited" },
    ]);
    expect(warn).toHaveBeenCalledWith(
      "poll failed",
      expect.objectContaining({ workflowId: "wf", message: "rate limited" }),
    );

    now += MIN;
    pollImpl = empty;
    await engine.tickPolls();
    expect(calls[1]).toEqual({ since: T0, until: now, cursor: null });
  });

  it("treats an invalid result like a throw", async () => {
    now = T0 + 5 * MIN;
    pollImpl = () => ({ items: "nope" }) as never;
    await engine.tickPolls();
    expect(await state()).toMatchObject({ since: null, lastError: expect.stringMatching(/items/) });
    expect(ofType("poll.failed")).toHaveLength(1);
  });

  it("starts one run per item; rejects invalid items and empty keys; dedupes repeated keys", async () => {
    now = T0 + 5 * MIN;
    pollImpl = () => ({
      items: [item("a"), item("bad", 5), item("a"), item(""), item("c")],
    });
    expect(await engine.tickPolls()).toBe(2);

    const runs = await storage.listRuns("t1", {});
    expect(runs).toHaveLength(2);
    const byKey = new Map<string, string>();
    for (const r of runs) {
      const run = await storage.getRun("t1", r.id);
      expect(run?.startedBy).toMatchObject({ kind: "poll", since: T0, until: now });
      const key = await itemKeyOf(r.id);
      expect(run?.trigger).toEqual({ id: key });
      byKey.set(key, r.id);
    }
    expect([...byKey.keys()].sort()).toEqual(["a", "c"]);

    const rejected = ofType("trigger.rejected");
    expect(rejected.map((e) => e.source)).toEqual([
      { kind: "poll", itemKey: "bad" },
      { kind: "poll", itemKey: "" },
    ]);
    expect(rejected[0]?.message).toMatch(/id/);
    expect(rejected[1]?.message).toBe("item key is empty");
    expect(ofType("trigger.deduped")).toMatchObject([{ key: "poll:wf:a", runId: byKey.get("a") }]);
    expect(ofType("poll.completed")).toMatchObject([{ items: 5, started: 2, rejected: 2 }]);

    await engine.drain();
    expect((await storage.getRun("t1", byKey.get("c") as string))?.status).toBe("completed");
  });

  it("rejects one item whose launch fails and starts the rest", async () => {
    const base = createMemoryStorage();
    storage = {
      ...base,
      createRun: (run, evs, at) =>
        (run.trigger as Payload).id === "x"
          ? Promise.reject(new Error("disk full"))
          : base.createRun(run, evs, at),
    };
    engine = newEngine();
    await deploy();
    now = T0 + 5 * MIN;
    pollImpl = () => ({ items: [item("x"), item("y")] });
    expect(await engine.tickPolls()).toBe(1);
    expect(ofType("trigger.rejected")).toMatchObject([
      { source: { kind: "poll", itemKey: "x" }, message: "disk full" },
    ]);
    expect((await state())?.since).toBe(now);
  });

  it("re-polls the interval after a crash before commitPoll and starts only unstarted items", async () => {
    let crash = true;
    engine = newEngine({
      __testHooks: {
        beforeCommitPoll: () => {
          if (crash) throw new Error("crash");
        },
      },
    });
    now = T0 + 5 * MIN;
    pollImpl = () => ({ items: [item("a")] });
    await engine.tickPolls();
    expect(await storage.listRuns("t1", {})).toHaveLength(1);
    // Nothing committed: the state still holds the lease and the old interval.
    expect(await state()).toMatchObject({ since: null, cursor: null });

    crash = false;
    now += MIN + 1; // the 60 s lease has expired
    pollImpl = () => ({ items: [item("a"), item("b")] });
    expect(await engine.tickPolls()).toBe(1);
    expect(calls[1]?.since).toBe(T0);
    const runs = await storage.listRuns("t1", {});
    const keys = await Promise.all(runs.map((r) => itemKeyOf(r.id)));
    expect(keys.sort()).toEqual(["a", "b"]);
    expect(ofType("trigger.deduped")).toMatchObject([{ key: "poll:wf:a" }]);
    expect((await state())?.since).toBe(now);
  });

  it("aborts ctx.signal and starts nothing when the lease is lost during a slow poll", async () => {
    const base = createMemoryStorage();
    const commits: boolean[] = [];
    storage = {
      ...base,
      // Another worker takes the (expired) lease over; this holder's renewal then fails.
      renewPollLease: async (lease: PollLease) => {
        await base.claimPoll(lease.state.tenantId, lease.state.workflowId, {
          workerId: "thief",
          leaseMs: MIN,
          now: now + MIN,
        });
        return false;
      },
      commitPoll: async (lease: PollLease, patch: PollPatch, at: number) => {
        const ok = await base.commitPoll(lease, patch, at);
        commits.push(ok);
        return ok;
      },
    };
    engine = newEngine({ poll: { leaseMs: 20 } });
    await deploy();
    now = T0 + 5 * MIN;
    let signal: AbortSignal | undefined;
    pollImpl = ({ ctx }) =>
      new Promise((resolve) => {
        signal = ctx.signal;
        ctx.signal.addEventListener("abort", () => resolve({ items: [item("a")] }));
      });
    expect(await engine.tickPolls()).toBe(0);
    expect(signal?.aborted).toBe(true);
    expect(commits).toEqual([false]);
    expect(await storage.listRuns("t1", {})).toHaveLength(0);
    expect(await state()).toMatchObject({ since: null, leaseOwner: "thief" });
    expect(ofType("poll.failed")).toHaveLength(1);
  });

  it("does not poll while now <= since, and resumes exactly at since", async () => {
    now = T0; // published at T0: since === now
    expect(await engine.tickPolls()).toBe(0);
    expect(calls).toHaveLength(0);
    now = T0 - 5 * MIN; // clock stepped back; nextAt (T0 + 1m) is not due either
    await engine.tickPolls();
    expect(calls).toHaveLength(0);
    const s = await state();
    expect(s).toMatchObject({ since: null, cursor: null, nextAt: T0 + MIN });
    expect(s?.lastError).toBeUndefined();
    expect(events).toEqual([]);

    now = T0 + MIN;
    await engine.tickPolls();
    expect(calls).toEqual([{ since: T0, until: T0 + MIN, cursor: null }]);
  });

  it("commits nextAt = since + interval when the clock is behind since at claim time", async () => {
    // The state is due (nextAt 0) but the clock reads before publishedAt.
    now = T0 - 10 * MIN;
    await engine.tickPolls();
    expect(calls).toHaveLength(0);
    expect(await state()).toMatchObject({ since: null, nextAt: T0 + MIN });
  });

  it("ignores workflows whose trigger is not a poll trigger", async () => {
    const v = await engine.saveWorkflow(
      "t1",
      { ...doc, id: "manual", trigger: { type: "core.manual", config: {} } },
      "u",
    );
    await engine.publish("t1", "manual", v.version, "u");
    now = T0 + MIN;
    await engine.tickPolls();
    expect(await storage.getPollState("t1", "manual")).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
