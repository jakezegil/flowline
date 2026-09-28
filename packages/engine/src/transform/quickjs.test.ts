import {
  DEBUG_SYNC,
  newQuickJSWASMModule,
  RELEASE_SYNC,
  TestQuickJSWASMModule,
} from "quickjs-emscripten";
import { describe, expect, it } from "vitest";
import { createNodeContext } from "../context";
import { quickjsRuntime } from "./quickjs";

const limits = { timeoutMs: 1000, memoryBytes: 64 * 1024 * 1024 };
const scope = {
  trigger: { name: "Ada", amount: 40 },
  steps: { load: { items: [1, 2, 3] } },
  loop: { item: { id: "x" }, index: 2 },
};

async function failure(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(
    () => {
      throw new Error("expected rejection");
    },
    (e: unknown) => e as Error,
  );
  expect(err.name).toBe("FatalError");
  return err;
}

describe("quickjsRuntime", () => {
  const rt = quickjsRuntime();

  it("computes a result from trigger, steps and loop", async () => {
    const out = await rt.run(
      `const total = steps.load.items.reduce((a, b) => a + b, 0);
       return { greeting: "Hi " + trigger.name, total: total + trigger.amount, at: loop.index, id: input.loop.item.id };`,
      scope,
      limits,
    );
    expect(out).toEqual({ greeting: "Hi Ada", total: 46, at: 2, id: "x" });
  });

  it("returns undefined when the code returns nothing", async () => {
    expect(await rt.run("const x = 1;", scope, limits)).toBeUndefined();
  });

  it("returns JSON values: dates as strings, functions dropped", async () => {
    const out = await rt.run(
      "return { d: new Date(0), f() {}, n: null, a: [1, 'two'] };",
      scope,
      limits,
    );
    expect(out).toEqual({ d: "1970-01-01T00:00:00.000Z", n: null, a: [1, "two"] });
  });

  it("does not let code mutate the caller's scope", async () => {
    const s = structuredClone(scope);
    await rt.run("trigger.name = 'Eve'; steps.load.items.push(4); return {};", s, limits);
    expect(s).toEqual(scope);
  });

  it.each([
    "fetch",
    "require",
    "process",
    "globalThis.process",
    "XMLHttpRequest",
    "setTimeout",
    "__flowkitInput",
  ])("%s is not available", async (name) => {
    expect(await rt.run(`return { type: typeof ${name} };`, scope, limits)).toEqual({
      type: "undefined",
    });
  });

  it("times out an infinite loop", async () => {
    const started = Date.now();
    const err = await failure(rt.run("while (true) {}", scope, limits));
    expect(err.message).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("fails when memory is exhausted", async () => {
    const err = await failure(
      rt.run("const huge = new Array(2 ** 24).fill(0); return { n: huge.length };", scope, limits),
    );
    expect(err.message).toMatch(/memory/i);
  });

  it("fails on deep recursion", async () => {
    const err = await failure(
      rt.run("function f() { return f() + 1; } return f();", scope, limits),
    );
    expect(err.message).toMatch(/stack/i);
  });

  it("reports thrown errors with their message and line", async () => {
    const err = await failure(
      rt.run("const a = 1;\n\nthrow new TypeError('bad value');", scope, limits),
    );
    expect(err.message).toContain("TypeError: bad value");
    expect(err.message).toContain("line 3");
  });

  it("reports reference errors and syntax errors", async () => {
    const ref = await failure(rt.run("return nope.x;", scope, limits));
    expect(ref.message).toContain("ReferenceError: 'nope' is not defined (line 1)");
    const syntax = await failure(rt.run("return {;", scope, limits));
    expect(syntax.message).toContain("SyntaxError");
  });

  it("fails when the result cannot be serialized", async () => {
    const err = await failure(rt.run("const o = {}; o.o = o; return o;", scope, limits));
    expect(err.message).toMatch(/circular/i);
  });

  it("rejects results over 1 MB of JSON", async () => {
    const err = await failure(rt.run("return { s: 'x'.repeat(1024 * 1024) };", scope, limits));
    expect(err.message).toBe("Transform result too large (max 1 MB)");
    expect(await rt.run("return { s: 'x'.repeat(1000 * 1000) };", scope, limits)).toMatchObject({
      s: expect.any(String),
    });
  });

  it("drops __proto__, constructor and prototype keys from results", async () => {
    const out = (await rt.run(
      `return {
         a: 1,
         ["__proto__"]: { polluted: true },
         constructor: { polluted: true },
         nested: { prototype: 2, ok: 3, list: [{ ["__proto__"]: { polluted: true }, v: 1 }] },
       };`,
      scope,
      limits,
    )) as Record<string, unknown>;
    expect(out).toEqual({ a: 1, nested: { ok: 3, list: [{ v: 1 }] } });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out, "__proto__")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("hides host-level failures behind a fixed message, keeping the cause", async () => {
    const boom = new Error("wasm exploded at 0xdeadbeef");
    const broken = quickjsRuntime({
      module: async () => ({
        newRuntime: () => {
          throw boom;
        },
      }),
    });
    const err = await failure(broken.run("return {};", scope, limits));
    expect(err.message).toBe("Transform failed (internal error)");
    expect(err.cause).toBe(boom);
  });

  it("does not leak handles over many sequential runs", async () => {
    // The debug build aborts on disposing a runtime that still owns objects, and its leak
    // sanitizer reports any un-freed allocation.
    const module = new TestQuickJSWASMModule(await newQuickJSWASMModule(DEBUG_SYNC));
    const tracked = quickjsRuntime({ module: async () => module });
    for (let i = 0; i < 100; i++) {
      expect(
        await tracked.run(`return { i: ${i}, n: steps.load.items.length };`, scope, limits),
      ).toEqual({ i, n: 3 });
      expect((await failure(tracked.run("throw new Error('x')", scope, limits))).message).toBe(
        "Error: x (line 1)",
      );
      if (i % 50 === 0) {
        const err = await failure(
          tracked.run("while (true) {}", scope, { ...limits, timeoutMs: 20 }),
        );
        expect(err.message).toContain("timed out");
      }
    }
    expect([...module.runtimes].filter((r) => r.alive)).toEqual([]);
    expect([...module.contexts].filter((c) => c.alive)).toEqual([]);
    expect(module.getFFI().QTS_RecoverableLeakCheck()).toBe(0);
  }, 60_000);

  it("disposes everything when a tiny memory limit fails the run", async () => {
    const module = new TestQuickJSWASMModule(await newQuickJSWASMModule(DEBUG_SYNC));
    const tracked = quickjsRuntime({ module: async () => module });
    const bigScope = { trigger: {}, steps: { a: "y".repeat(100_000) } };
    for (const memoryBytes of [1, 1024, 16 * 1024, 64 * 1024]) {
      for (let i = 0; i < 10; i++) {
        const err = await failure(
          tracked.run("return { n: steps.a.length };", bigScope, { timeoutMs: 1000, memoryBytes }),
        );
        expect(err.message).toContain("out of memory");
        const inside = await failure(
          tracked.run("const a = []; for (;;) a.push({ i: a.length });", scope, {
            timeoutMs: 5000,
            memoryBytes,
          }),
        );
        expect(inside.message).toContain("out of memory");
      }
    }
    expect([...module.runtimes].filter((r) => r.alive)).toEqual([]);
    expect([...module.contexts].filter((c) => c.alive)).toEqual([]);
    expect(module.getFFI().QTS_RecoverableLeakCheck()).toBe(0);
    expect(await tracked.run("return { ok: 1 };", scope, limits)).toEqual({ ok: 1 });
  }, 60_000);

  it("keeps working without growing its heap after repeated out-of-memory failures", async () => {
    // The debug build's allocator ignores the memory limit, so this runs on the release build.
    const module = await newQuickJSWASMModule(RELEASE_SYNC);
    const isolated = quickjsRuntime({ module: async () => module });
    const oom = () =>
      failure(isolated.run("const huge = new Array(2 ** 24).fill(0); return {};", scope, limits));
    expect((await oom()).message).toContain("out of memory");
    const heap = module.getWasmMemory().buffer.byteLength;
    for (let i = 0; i < 10; i++) expect((await oom()).message).toContain("out of memory");
    expect(module.getWasmMemory().buffer.byteLength).toBe(heap);
    expect(await isolated.run("return { ok: true };", scope, limits)).toEqual({ ok: true });
  }, 30_000);
});

describe("ctx.transform default", () => {
  it("uses QuickJS when no runtime is configured", async () => {
    const ctx = createNodeContext({
      runId: "r",
      tenantId: "t",
      workflowId: "w",
      stepId: "s",
      stepPath: "s",
      attempt: 1,
      idempotencyKey: "k",
      services: {},
      signal: new AbortController().signal,
      clock: () => 0,
      scope: { trigger: { a: 2 }, steps: {}, run: { id: "r" } },
    });
    expect(await ctx.transform.run("return { b: trigger.a * 2 };", ctx.scope, limits)).toEqual({
      b: 4,
    });
  });
});
