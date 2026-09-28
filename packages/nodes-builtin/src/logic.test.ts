import { isSignal } from "@flowkit/core";
import { describe, expect, it } from "vitest";
import { fakeContext } from "../test/fake-context";
import { conditionNode, forEachNode, stopNode, switchNode } from "./logic";
import { and, eq, gt } from "./rules";

const ctx = fakeContext();

describe("core.condition", () => {
  const run = (rules: unknown) =>
    conditionNode.run({ input: conditionNode.input.parse({ rules }), ctx });

  it("takes the If branch when the rules match", async () => {
    expect(await run(and(eq("won", "won"), gt(5, 1)))).toMatchObject({
      kind: "branch",
      branch: "if",
      output: { matched: true },
    });
  });

  it("takes the Else branch otherwise", async () => {
    const result = await run(and(eq("lost", "won")));
    expect(isSignal(result)).toBe(true);
    expect(result).toMatchObject({ kind: "branch", branch: "else", output: { matched: false } });
  });

  it("rejects malformed rules", () => {
    expect(conditionNode.input.safeParse({ rules: { combinator: "and" } }).success).toBe(false);
    expect(
      conditionNode.input.safeParse({ rules: and({ left: 1, op: "like" as never }) }).success,
    ).toBe(false);
  });
});

describe("core.switch", () => {
  const cases = [
    { id: "small", label: "Small", value: 1 },
    { id: "large", label: "Large", value: "2" },
    { id: "again", label: "Also large", value: 2 },
  ];
  const run = (value: unknown) =>
    switchNode.run({ input: switchNode.input.parse({ value, cases }), ctx });

  it("takes the first case whose value matches (loosely)", async () => {
    expect(await run(2)).toMatchObject({ branch: "large", output: { matched: "large" } });
    expect(await run("1")).toMatchObject({ branch: "small", output: { matched: "small" } });
  });

  it("takes Default when nothing matches", async () => {
    expect(await run(3)).toMatchObject({ branch: "default", output: { matched: "default" } });
  });

  it("requires unique, path-safe case IDs other than default", () => {
    const parse = (c: unknown[]) => switchNode.input.safeParse({ value: 1, cases: c });
    expect(parse([]).success).toBe(true);
    expect(parse([{ id: "a", label: "A", value: 1 }]).success).toBe(true);
    const dup = parse([
      { id: "a", label: "A", value: 1 },
      { id: "a", label: "B", value: 2 },
    ]);
    expect(dup.success).toBe(false);
    expect(dup.error?.issues[0]?.message).toBe('Case ID "a" is used twice');
    expect(parse([{ id: "default", label: "D", value: 1 }]).error?.issues[0]?.message).toBe(
      'Case ID "default" is reserved for the Default branch',
    );
    expect(parse([{ id: "a/b", label: "A", value: 1 }]).success).toBe(false);
  });
});

describe("core.forEach", () => {
  it("hands the items to the engine to iterate", async () => {
    const items = [{ name: "Ada" }, { name: "Bob" }];
    expect(await forEachNode.run({ input: forEachNode.input.parse({ items }), ctx })).toEqual({
      items,
    });
  });

  it("requires a list", () => {
    expect(forEachNode.input.safeParse({ items: "nope" }).success).toBe(false);
  });
});

describe("core.stop", () => {
  it("stops the run with the reason", async () => {
    expect(
      await stopNode.run({ input: stopNode.input.parse({ reason: "Not won" }), ctx }),
    ).toMatchObject({ kind: "stop", reason: "Not won" });
  });

  it("stops without a reason", async () => {
    const result = await stopNode.run({ input: stopNode.input.parse({}), ctx });
    expect(result).toMatchObject({ kind: "stop" });
    expect(result).not.toHaveProperty("reason");
  });
});
