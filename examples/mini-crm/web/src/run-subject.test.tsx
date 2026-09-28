import { describe, expect, it } from "vitest";
import { createSubjectStore } from "./run-subject";

/** A store over a controllable fetch: every call waits until the test settles it. */
function harness(opts: { concurrency?: number; maxEntries?: number } = {}) {
  let clock = 0;
  const calls: string[] = [];
  const open = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  let maxOpen = 0;
  const tasks: (() => void)[] = [];
  const store = createSubjectStore({
    ...opts,
    retryMs: 1000,
    now: () => clock,
    schedule: (fn) => tasks.push(fn),
    fetchTrigger: (id) =>
      new Promise((resolve, reject) => {
        calls.push(id);
        open.set(id, { resolve, reject });
        maxOpen = Math.max(maxOpen, open.size);
      }),
  });
  const tick = async () => {
    for (const t of tasks.splice(0)) t();
    await Promise.resolve();
    await Promise.resolve();
  };
  const settle = async (id: string, value: unknown, fail = false) => {
    const o = open.get(id);
    if (!o) throw new Error(`no open fetch for ${id}`);
    open.delete(id);
    if (fail) o.reject(new Error("boom"));
    else o.resolve(value);
    await tick();
  };
  return {
    store,
    calls,
    open,
    tick,
    settle,
    maxOpen: () => maxOpen,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("createSubjectStore", () => {
  it("fetches a run once, however often the list re-renders", async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) h.store.request("r1");
    await h.tick();
    h.store.request("r1");
    expect(h.calls).toEqual(["r1"]);
    await h.settle("r1", { contact: { email: "ada@example.com" } });
    expect(h.store.request("r1")).toBe("ada@example.com");
    expect(h.calls).toEqual(["r1"]);
  });

  it("does not refetch a failed run on every render; retries after a growing backoff", async () => {
    const h = harness();
    h.store.request("r1");
    await h.tick();
    await h.settle("r1", undefined, true);
    for (let i = 0; i < 10; i++) h.store.request("r1");
    await h.tick();
    expect(h.calls).toEqual(["r1"]);

    h.advance(1000);
    h.store.request("r1");
    await h.tick();
    expect(h.calls).toEqual(["r1", "r1"]);
    await h.settle("r1", undefined, true);

    // The second failure waits twice as long.
    h.advance(1000);
    h.store.request("r1");
    await h.tick();
    expect(h.calls).toHaveLength(2);
    h.advance(1000);
    h.store.request("r1");
    await h.tick();
    expect(h.calls).toHaveLength(3);
    await h.settle("r1", { deal: { name: "Acme renewal" } });
    expect(h.store.get("r1")).toBe("Acme renewal");
  });

  it("keeps at most `concurrency` fetches in flight and works through the rest", async () => {
    const h = harness({ concurrency: 4 });
    const ids = Array.from({ length: 10 }, (_, i) => `r${i}`);
    for (const id of ids) h.store.request(id);
    await h.tick();
    expect(h.open.size).toBe(4);
    while (h.open.size > 0) {
      const [id] = h.open.keys();
      await h.settle(id as string, { email: `${id}@x.io` });
    }
    expect(h.maxOpen()).toBe(4);
    expect(h.calls).toEqual(ids);
    expect(ids.map((id) => h.store.get(id))).toEqual(ids.map((id) => `${id}@x.io`));
  });

  it("records a run with no subject as null, and evicts the least recently used", async () => {
    const h = harness({ maxEntries: 2 });
    for (const id of ["a", "b"]) h.store.request(id);
    await h.tick();
    await h.settle("a", { note: "nothing" });
    await h.settle("b", { email: "b@x.io" });
    expect(h.store.get("a")).toBeNull();
    h.store.request("c");
    await h.tick();
    await h.settle("c", { email: "c@x.io" });
    // "a" was read after "b", so "b" is the one evicted.
    expect(h.store.get("b")).toBeUndefined();
    expect(h.store.get("a")).toBeNull();
    expect(h.store.get("c")).toBe("c@x.io");
  });

  it("notifies subscribers when a subject loads", async () => {
    const h = harness();
    let n = 0;
    const off = h.store.subscribe(() => n++);
    h.store.request("r1");
    await h.tick();
    await h.settle("r1", { email: "x@y.z" });
    expect(n).toBe(1);
    off();
    h.store.request("r2");
    await h.tick();
    await h.settle("r2", { email: "x@y.z" });
    expect(n).toBe(1);
  });
});
