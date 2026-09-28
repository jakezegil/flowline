import { isSignal, loop } from "@flowlinejs/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
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

  describe("case sensitivity", () => {
    const regions = [
      { id: "emea", label: "EMEA", value: "emea" },
      { id: "apac", label: "APAC", value: "apac" },
    ];
    const route = (value: unknown, caseSensitive?: boolean) =>
      switchNode.run({
        input: switchNode.input.parse({ value, cases: regions, caseSensitive }),
        ctx,
      });

    it('matches "EMEA" to "emea" by default', async () => {
      expect(await route("EMEA")).toMatchObject({ branch: "emea" });
      expect(await route("EMEA", false)).toMatchObject({ branch: "emea" });
    });

    it("matches case exactly with caseSensitive", async () => {
      expect(await route("EMEA", true)).toMatchObject({ branch: "default" });
      expect(await route("emea", true)).toMatchObject({ branch: "emea" });
    });

    it('shows "Match case" in the editor', () => {
      expect(JSON.stringify(z.toJSONSchema(switchNode.input))).toContain('"Match case"');
    });
  });

  describe("compare", () => {
    const route = (value: unknown, compare?: "strict" | "loose", caseSensitive?: boolean) =>
      switchNode.run({
        input: switchNode.input.parse({ value, cases, compare, caseSensitive }),
        ctx,
      });

    it("defaults to loose", async () => {
      expect(switchNode.input.parse({ value: 1, cases }).compare).toBe("loose");
      expect(await route("1")).toMatchObject({ branch: "small" });
    });

    it("strict matches only values of the same type", async () => {
      expect(await route("1", "strict")).toMatchObject({ branch: "default" });
      expect(await route(2, "strict")).toMatchObject({ branch: "again" });
      expect(await route("2", "strict")).toMatchObject({ branch: "large" });
    });

    it("strict ignores caseSensitive: always case-sensitive", async () => {
      const regions = [{ id: "emea", label: "EMEA", value: "emea" }];
      const r = (value: string, caseSensitive?: boolean) =>
        switchNode.run({
          input: switchNode.input.parse({
            value,
            cases: regions,
            compare: "strict",
            caseSensitive,
          }),
          ctx,
        });
      expect(await r("EMEA")).toMatchObject({ branch: "default" });
      expect(await r("EMEA", false)).toMatchObject({ branch: "default" });
      expect(await r("emea")).toMatchObject({ branch: "emea" });
    });

    it("rejects an unknown compare value", () => {
      expect(switchNode.input.safeParse({ value: 1, cases, compare: "fuzzy" }).success).toBe(false);
    });
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
  it("hands the items to the engine to iterate with loop()", async () => {
    const items = [{ name: "Ada" }, { name: "Bob" }];
    const result = await forEachNode.run({ input: forEachNode.input.parse({ items }), ctx });
    expect(isSignal(result)).toBe(true);
    expect(result).toEqual(loop(items));
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
