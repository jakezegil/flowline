import {
  createRegistry,
  definePlugin,
  FatalError,
  type NodeContext,
  type TransformRuntime,
  UI_META_KEY,
} from "@flowlinejs/core";
import { describe, expect, it } from "vitest";
import { transform } from "./transform";

const scope = { trigger: { a: 2 }, steps: { load: { n: 5 } } };

/** Records calls and answers with `result` (the real QuickJS runtime is tested in the engine). */
function runtime(result: unknown | (() => never)) {
  const calls: { code: string; scope: unknown; opts: unknown }[] = [];
  const rt: TransformRuntime = {
    async run(code, s, opts) {
      calls.push({ code, scope: s, opts });
      return typeof result === "function" ? (result as () => never)() : result;
    },
  };
  return { rt, calls };
}

async function run(code: string, rt: TransformRuntime): Promise<unknown> {
  const input = transform.input.parse({ code, outputFields: [{ name: "total", type: "number" }] });
  return transform.run({ input, ctx: { transform: rt, scope } as unknown as NodeContext });
}

describe("core.transform", () => {
  it("runs the code over the step scope with 1s / 64MB limits", async () => {
    const { rt, calls } = runtime({ total: 7 });
    expect(await run("return { total: trigger.a + steps.load.n };", rt)).toEqual({ total: 7 });
    expect(calls).toEqual([
      {
        code: "return { total: trigger.a + steps.load.n };",
        scope,
        opts: { timeoutMs: 1000, memoryBytes: 64 * 1024 * 1024 },
      },
    ]);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["a string", "x"],
    ["an array", [1, 2]],
  ])("fails when the code returns %s", async (_label, value) => {
    const err = await run("return 1;", runtime(value).rt).catch((e: Error) => e);
    expect(err).toBeInstanceOf(FatalError);
    expect((err as Error).message).toContain("must return an object");
  });

  it("propagates runtime failures", async () => {
    const failure = new FatalError("Transform timed out after 1000ms");
    const err = await run(
      "while (true) {}",
      runtime(() => {
        throw failure;
      }).rt,
    ).catch((e: unknown) => e);
    expect(err).toBe(failure);
  });

  it("declares a code widget and fields-based output", () => {
    const registry = createRegistry([
      definePlugin({ id: "core", name: "Core", nodes: [transform] }),
    ]);
    const node = registry.manifest().nodes.find((n) => n.type === "core.transform");
    const input = node?.input as
      | { properties?: Record<string, Record<string, unknown>> }
      | undefined;
    const code = input?.properties?.code;
    expect(code?.[UI_META_KEY]).toMatchObject({ widget: "code", multiline: true });
    expect(code?.description).toContain("constructor");
    expect(node?.output).toEqual({ kind: "fields", configPath: "outputFields" });
  });
});
