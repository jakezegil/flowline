/**
 * Compare modes (spec §6): every row of the operator table (§6.3) and of the value-pair examples
 * (§6.4), pinned in both modes, plus custom operators and the code-first helpers.
 */
import { FatalError, ref } from "@flowlinejs/core";
import { describe, expect, it } from "vitest";
import {
  and,
  type CompareMode,
  type CustomOperator,
  contains,
  createConditionRulesSchema,
  custom,
  endsWith,
  eq,
  evaluateRules,
  gt,
  gte,
  isEmpty,
  isFalse,
  isIn,
  isNotEmpty,
  isTrue,
  loosely,
  lt,
  neq,
  notContains,
  or,
  type Rule,
  startsWith,
  strictEquals,
  strictly,
} from "./rules";

const MODES = ["loose", "strict"] as const satisfies readonly CompareMode[];

const one = (rule: Rule, compare: CompareMode, operators?: Record<string, CustomOperator>) =>
  evaluateRules({ combinator: "and", rules: [rule] }, { compare, operators });

/** `[row text, rule, loose result, strict result]`. */
type Row = [string, Rule, boolean, boolean];

/** Expands rows into one case per mode: `[name, rule, mode, expected]`. */
const perMode = (rows: Row[]) =>
  rows.flatMap(([name, rule, loose, strict]) => [
    [`${name} (loose)`, rule, "loose", loose] as const,
    [`${name} (strict)`, rule, "strict", strict] as const,
  ]);

const isUnassigned: CustomOperator = {
  id: "isUnassigned",
  label: "is unassigned",
  arity: "unary",
  types: ["string", "object", "any"],
  evaluate: (left) => left === null || left === undefined || left === "",
};
/** Matches only when evaluated in strict mode: shows which mode the operator was given. */
const inStrictMode: CustomOperator = {
  id: "inStrictMode",
  label: "in strict mode",
  arity: "unary",
  evaluate: (_left, _right, ctx) => ctx.compare === "strict",
};
const OPERATORS = { isUnassigned, inStrictMode };

describe("§6.3 operator table", () => {
  const rows: Row[] = [
    // eq / neq
    ["eq/neq: numeric text as numbers", eq("5", 5), true, false],
    ["eq/neq: numeric text as numbers (neq)", neq("5", 5), false, true],
    ['eq/neq: "true"/"false" as booleans', eq(true, "true"), true, false],
    ['eq/neq: "true"/"false" as booleans (false)', eq("false", false), true, false],
    [
      "eq/neq: ISO dates by instant",
      eq("2026-01-01T10:00:00Z", "2026-01-01T11:00:00+01:00"),
      true,
      false,
    ],
    ["eq/neq: null = undefined", eq(null, undefined), true, false],
    ["eq/neq: case-insensitive unless caseSensitive", eq("Won", "won"), true, false],
    ["eq/neq: caseSensitive", eq("Won", "won", { caseSensitive: true }), false, false],
    ["eq/neq: strictEquals same text", eq("won", "won"), true, true],
    ["eq/neq: strictEquals arrays deep by index", eq([1, { a: "x" }], [1, { a: "x" }]), true, true],
    ["eq/neq: strictEquals arrays by index order", eq([1, 2], [2, 1]), false, false],
    [
      "eq/neq: strictEquals objects deep, key order ignored",
      eq({ a: 1, b: 2 }, { b: 2, a: 1 }),
      true,
      true,
    ],
    ["eq/neq: strictEquals NaN never equal", eq(Number.NaN, Number.NaN), false, false],
    ["eq/neq: -0 equals 0", eq(-0, 0), true, true],

    // gt gte lt lte
    ["gt gte lt lte: both numbers numeric", gt(10, 9), true, true],
    ["gt gte lt lte: numeric text as numbers", gt("10", "9"), true, false],
    ["gt gte lt lte: number vs numeric text", gt(10, "9"), true, false],
    ["gt gte lt lte: gte number vs numeric text", gte(5, "5"), true, false],
    [
      "gt gte lt lte: both ISO date strings by instant",
      gt("2026-03-01T00:00:00Z", "2026-02-28T23:59:59Z"),
      true,
      true,
    ],
    ["gt gte lt lte: ISO date vs non-date text by code point", lt("2026-01-01", "zzz"), true, true],
    ["gt gte lt lte: text by code point", lt("apple", "banana"), true, true],
    ["gt gte lt lte: text by code point, case", lt("Zebra", "apple"), true, true],
    ["gt gte lt lte: null is false", gt(null, 0), false, false],
    ["gt gte lt lte: undefined is false", lt(undefined, 5), false, false],
    ["gt gte lt lte: booleans are not ordered", gt(true, false), false, false],
    ["gt gte lt lte: number vs word is false", gt(5, "abc"), false, false],

    // contains / notContains
    ["contains: text substring, case-folded", contains("Hello world", "hello"), true, false],
    ["contains: text substring, same case", contains("Hello world", "Hello"), true, true],
    ["contains: numbers stringified (left)", contains(12345, "23"), true, false],
    ["contains: numbers stringified (right)", contains("order 42", 42), true, false],
    ["contains: array item looseEquals", contains([1, 2], "2"), true, false],
    ["contains: array item strictEquals", contains([1, 2], 2), true, true],
    ["contains: array object item", contains([{ id: 1 }], { id: 1 }), true, true],
    ["contains: missing left", contains(undefined, "a"), false, false],
    ["notContains = !contains", notContains([1, 2], "2"), false, true],
    ["notContains = !contains (text)", notContains("Hello", "hello"), false, true],
    ["notContains = !contains (missing left)", notContains(undefined, "a"), true, true],

    // startsWith / endsWith
    ["startsWith: case-folded", startsWith("Hello", "he"), true, false],
    ["startsWith: same case", startsWith("Hello", "He"), true, true],
    ["endsWith: stringified primitives", endsWith(12345, "45"), true, false],
    ["endsWith: both strings", endsWith("jane@acme.com", "@acme.com"), true, true],
    ["startsWith: object is false", startsWith({ a: 1 }, "a"), false, false],

    // in
    ["in: comma-separated text", isIn("won", "won, lost"), true, false],
    ["in: array, same type", isIn("won", ["won", "lost"]), true, true],
    ["in: array items looseEquals", isIn(5, ["5"]), true, false],
    ["in: array items case-folded", isIn("WON", ["won"]), true, false],
    ["in: not in array", isIn("open", ["won", "lost"]), false, false],

    // isEmpty / isNotEmpty
    ["isEmpty: null", isEmpty(null), true, true],
    ["isEmpty: undefined", isEmpty(undefined), true, true],
    ['isEmpty: ""', isEmpty(""), true, true],
    ["isEmpty: []", isEmpty([]), true, true],
    ["isEmpty: {}", isEmpty({}), true, true],
    ["isEmpty: 0 is not empty", isEmpty(0), false, false],
    ["isNotEmpty: text", isNotEmpty("x"), true, true],

    // isTrue / isFalse
    ["isTrue: true", isTrue(true), true, true],
    ['isTrue: "true"', isTrue("true"), true, false],
    ["isFalse: false", isFalse(false), true, true],
    ['isFalse: "false"', isFalse("false"), true, false],
    ["isTrue: 1 is not true", isTrue(1), false, false],
  ];

  it.each(perMode(rows))("%s", (_name, rule, mode, expected) => {
    expect(one(rule, mode)).toBe(expected);
  });

  it.each(MODES)("custom operator: evaluate(left, right, { compare: %s })", (mode) => {
    expect(one(custom("inStrictMode", 1), mode, OPERATORS)).toBe(mode === "strict");
  });

  it.each(MODES)("unknown operator id: false (%s)", (mode) => {
    expect(one(custom("matches", 1, 1), mode)).toBe(false);
    expect(one(custom("isUnassigned", undefined), mode)).toBe(false);
  });

  it.each(MODES)("empty and / or group: true / false (%s)", (compare) => {
    expect(evaluateRules({ combinator: "and", rules: [] }, { compare })).toBe(true);
    expect(evaluateRules({ combinator: "or", rules: [] }, { compare })).toBe(false);
  });
});

describe("§6.4 value-pair examples", () => {
  const rows: Row[] = [
    ["5 eq 5", eq(5, 5), true, true],
    ['5 eq "5"', eq(5, "5"), true, false],
    ['"5" eq "5.0"', eq("5", "5.0"), true, false],
    ['"Won" eq "won"', eq("Won", "won"), true, false],
    ['"Won" eq "won" with caseSensitive', eq("Won", "won", { caseSensitive: true }), false, false],
    ['true eq "true"', eq(true, "true"), true, false],
    [
      '"2026-01-31" eq "2026-01-31T00:00:00Z"',
      eq("2026-01-31", "2026-01-31T00:00:00Z"),
      true,
      false,
    ],
    ["null eq undefined", eq(null, undefined), true, false],
    ["null eq null", eq(null, null), true, true],
    ['[1, 2] eq ["1", "2"]', eq([1, 2], ["1", "2"]), true, false],
    ["{ a: 1 } eq { a: 1 }", eq({ a: 1 }, { a: 1 }), true, true],
    ['5 lt "10"', lt(5, "10"), true, false],
    ['"5" lt "10"', lt("5", "10"), true, false],
    ['"2026-02-01" gt "2026-01-31T09:00Z"', gt("2026-02-01", "2026-01-31T09:00Z"), true, true],
    ["null gt 0", gt(null, 0), false, false],
    ['"Hello world" contains "hello"', contains("Hello world", "hello"), true, false],
    ['12345 contains "23"', contains(12345, "23"), true, false],
    ['[1, 2] contains "2"', contains([1, 2], "2"), true, false],
    ["[1, 2] contains 2", contains([1, 2], 2), true, true],
    ['"won" in "won, lost"', isIn("won", "won, lost"), true, false],
    ['5 in ["5"]', isIn(5, ["5"]), true, false],
    ["5 in [5]", isIn(5, [5]), true, true],
    ['"true" isTrue', isTrue("true"), true, false],
    ["1 isTrue", isTrue(1), false, false],
    ['"" isEmpty', isEmpty(""), true, true],
    ['"  " isEmpty', isEmpty("  "), false, false],
    ["0 isEmpty", isEmpty(0), false, false],
  ];

  it.each(perMode(rows))("%s", (_name, rule, mode, expected) => {
    expect(one(rule, mode)).toBe(expected);
  });

  it.each(MODES)("undefined isUnassigned (host) is host-defined (%s)", (mode) => {
    expect(one(custom("isUnassigned", undefined), mode, OPERATORS)).toBe(true);
    expect(one(custom("isUnassigned", "x"), mode, OPERATORS)).toBe(false);
  });
});

describe("strict unset handling", () => {
  it("compares null and undefined literally in eq", () => {
    expect(one(eq(null, null), "strict")).toBe(true);
    expect(one(eq(undefined, undefined), "strict")).toBe(true);
    expect(one(eq(null, undefined), "strict")).toBe(false);
    expect(one(eq(undefined, null), "strict")).toBe(false);
  });

  it("makes every other binary operator false", () => {
    expect(one(gt(null, 0), "strict")).toBe(false);
    expect(one(gte(0, undefined), "strict")).toBe(false);
    expect(one(contains(undefined, "a"), "strict")).toBe(false);
    expect(one(contains([null], null), "strict")).toBe(false);
    expect(one(startsWith(null, ""), "strict")).toBe(false);
    expect(one(isIn(null, [null]), "strict")).toBe(false);
  });

  const pairs: [unknown, unknown][] = [
    [null, null],
    [null, undefined],
    [5, "5"],
    ["Won", "won"],
    [[1], [1]],
    [{ a: 1 }, { a: 2 }],
    [Number.NaN, Number.NaN],
  ];
  it.each(MODES)("neq is !eq (%s)", (mode) => {
    for (const [a, b] of pairs) {
      expect(one(neq(a, b), mode)).toBe(!one(eq(a, b), mode));
    }
  });

  it("ignores caseSensitive under strict", () => {
    expect(one(eq("Won", "won"), "strict")).toBe(false);
    expect(one(eq("Won", "won", { caseSensitive: false }), "strict")).toBe(false);
    expect(one(eq("Won", "won", { caseSensitive: true }), "strict")).toBe(false);
    expect(one(contains("ABC", "b", { caseSensitive: false }), "strict")).toBe(false);
    expect(one(isIn("WON", ["won"], { caseSensitive: false }), "strict")).toBe(false);
  });
});

describe("strictEquals", () => {
  it("is === for primitives", () => {
    expect(strictEquals(1, 1)).toBe(true);
    expect(strictEquals("a", "a")).toBe(true);
    expect(strictEquals(1, "1")).toBe(false);
    expect(strictEquals(Number.NaN, Number.NaN)).toBe(false);
    expect(strictEquals(0, -0)).toBe(true);
  });

  it("compares arrays by index and plain objects by own keys", () => {
    expect(strictEquals([1, [2, { a: "x" }]], [1, [2, { a: "x" }]])).toBe(true);
    expect(strictEquals([1, 2], [1, 2, 3])).toBe(false);
    expect(strictEquals({ a: 1, b: [2] }, { b: [2], a: 1 })).toBe(true);
    expect(strictEquals({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(strictEquals({ a: undefined }, { b: undefined })).toBe(false);
    expect(strictEquals([1], { 0: 1 })).toBe(false);
  });

  it("is false for anything else", () => {
    expect(strictEquals(new Date(0), new Date(0))).toBe(false);
  });
});

describe("compare mode resolution", () => {
  it("uses rules.compare over the option, and the option over loose", () => {
    expect(evaluateRules(strictly(and(eq(5, "5"))), { compare: "loose" })).toBe(false);
    expect(evaluateRules(loosely(and(eq(5, "5"))), { compare: "strict" })).toBe(true);
    expect(evaluateRules(and(eq(5, "5")), { compare: "strict" })).toBe(false);
    expect(evaluateRules(and(eq(5, "5")))).toBe(true);
  });

  it("applies the top-level mode to nested groups", () => {
    const nested = { ...or(eq(5, "5")), compare: "loose" } as never;
    expect(evaluateRules(strictly(and(nested)))).toBe(false);
  });
});

describe("custom operators", () => {
  const calls: unknown[][] = [];
  const spy = (arity: "unary" | "binary"): CustomOperator => ({
    id: "spy",
    label: "spy",
    arity,
    evaluate: (left, right, ctx) => {
      calls.push([left, right, ctx]);
      return true;
    },
  });

  it("gives a unary operator right === undefined", () => {
    calls.length = 0;
    expect(one({ left: "a", op: "spy", right: "ignored" }, "strict", { spy: spy("unary") })).toBe(
      true,
    );
    expect(calls).toEqual([["a", undefined, { compare: "strict" }]]);
  });

  it("gives a binary operator right, or undefined when missing", () => {
    calls.length = 0;
    one(custom("spy", "a", 7), "loose", { spy: spy("binary") });
    one(custom("spy", "a"), "loose", { spy: spy("binary") });
    expect(calls).toEqual([
      ["a", 7, { compare: "loose" }],
      ["a", undefined, { compare: "loose" }],
    ]);
  });

  it("fails fatally with the operator id when evaluate throws", () => {
    const boom: CustomOperator = {
      id: "boom",
      label: "boom",
      arity: "unary",
      evaluate: () => {
        throw new Error("bad host code");
      },
    };
    const run = () => one(custom("boom", 1), "loose", { boom });
    expect(run).toThrow(FatalError);
    expect(run).toThrow(/"boom"/);
    expect(run).toThrow(/bad host code/);
  });

  it("does not shadow built-in operators", () => {
    const eqOverride: CustomOperator = {
      id: "eq",
      label: "eq",
      arity: "binary",
      evaluate: () => false,
    };
    expect(one(eq(1, 1), "loose", { eq: eqOverride })).toBe(true);
  });
});

describe("helpers", () => {
  it("strictly / loosely set the compare mode", () => {
    const g = and(eq(ref("trigger.n"), 5));
    expect(strictly(g)).toEqual({ ...g, compare: "strict" });
    expect(loosely(g)).toEqual({ ...g, compare: "loose" });
    expect(g).not.toHaveProperty("compare");
  });

  it("custom builds a rule with an operator id", () => {
    expect(custom("isUnassigned", ref("trigger.owner"))).toEqual({
      left: { $ref: "trigger.owner" },
      op: "isUnassigned",
    });
    expect(custom("within", 5, [1, 10])).toEqual({ left: 5, op: "within", right: [1, 10] });
  });

  it("round-trip through the condition rules schema", () => {
    const schema = createConditionRulesSchema({
      defaultCompare: "loose",
      operators: [isUnassigned],
    });
    const strict = strictly(and(custom("isUnassigned", ref("trigger.owner")), eq(1, 1)));
    expect(schema.parse(strict)).toEqual(strict);
    const loose = loosely(or(eq("a", "b")));
    expect(schema.parse(loose)).toEqual(loose);
    expect(schema.parse(and(eq(1, 1)))).toEqual({ ...and(eq(1, 1)), compare: "loose" });
  });

  it("the schema rejects unregistered operators and unknown compare values", () => {
    const schema = createConditionRulesSchema({ defaultCompare: "strict", operators: [] });
    expect(schema.safeParse(and(custom("isUnassigned", 1))).success).toBe(false);
    expect(schema.safeParse({ ...and(), compare: "fuzzy" }).success).toBe(false);
    expect(schema.parse(and())).toEqual({ ...and(), compare: "strict" });
  });
});
