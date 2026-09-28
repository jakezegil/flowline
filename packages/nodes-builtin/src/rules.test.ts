import { ref } from "@flowkit/core";
import { describe, expect, it } from "vitest";
import {
  and,
  contains,
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
  looseEquals,
  lt,
  lte,
  neq,
  notContains,
  or,
  type Rule,
  type RuleGroup,
  RuleGroupSchema,
  startsWith,
} from "./rules";

const one = (rule: Rule) => evaluateRules({ combinator: "and", rules: [rule] });

describe("evaluateRules: operators", () => {
  const cases: [string, Rule, boolean][] = [
    // eq / neq: loose on number/string, dates as timestamps, deep for objects
    ["eq same string", { left: "won", op: "eq", right: "won" }, true],
    ["eq is case-sensitive", { left: "Won", op: "eq", right: "won" }, false],
    ["eq numeric string vs number", { left: "5", op: "eq", right: 5 }, true],
    ["eq number vs numeric string", { left: 5, op: "eq", right: "5.0" }, true],
    ["eq non-numeric string vs number", { left: "five", op: "eq", right: 5 }, false],
    ["eq empty string is not 0", { left: "", op: "eq", right: 0 }, false],
    ["eq booleans", { left: true, op: "eq", right: true }, true],
    ["eq boolean vs string is strict", { left: true, op: "eq", right: "yes" }, false],
    ["eq null vs undefined", { left: null, op: "eq", right: undefined }, true],
    ["eq null vs 0", { left: null, op: "eq", right: 0 }, false],
    [
      "eq same instant, different offsets",
      { left: "2026-01-01T10:00:00Z", op: "eq", right: "2026-01-01T11:00:00+01:00" },
      true,
    ],
    ["eq arrays deeply", { left: [1, { a: "x" }], op: "eq", right: [1, { a: "x" }] }, true],
    [
      "eq objects ignore key order",
      { left: { a: 1, b: 2 }, op: "eq", right: { b: 2, a: 1 } },
      true,
    ],
    ["eq objects differ", { left: { a: 1 }, op: "eq", right: { a: 2 } }, false],
    ["neq different", { left: "a", op: "neq", right: "b" }, true],
    ["neq loose equal", { left: "5", op: "neq", right: 5 }, false],

    // ordering
    ["gt numbers", { left: 10, op: "gt", right: 9 }, true],
    ["gt numeric strings compare as numbers", { left: "10", op: "gt", right: "9" }, true],
    ["gt equal", { left: 5, op: "gt", right: 5 }, false],
    ["gte equal", { left: 5, op: "gte", right: "5" }, true],
    ["lt numbers", { left: 1, op: "lt", right: 2 }, true],
    ["lte equal", { left: 2, op: "lte", right: 2 }, true],
    ["lte greater", { left: 3, op: "lte", right: 2 }, false],
    ["gt dates", { left: "2026-03-01T00:00:00Z", op: "gt", right: "2026-02-28T23:59:59Z" }, true],
    ["lt date-only strings", { left: "2026-01-01", op: "lt", right: "2026-01-02" }, true],
    ["lt plain strings", { left: "apple", op: "lt", right: "banana" }, true],
    ["gt with null is false", { left: null, op: "gt", right: 0 }, false],
    ["lt with missing value is false", { left: undefined, op: "lt", right: 5 }, false],
    ["gt number vs word is false", { left: 5, op: "gt", right: "abc" }, false],

    // text & list membership
    ["contains substring", { left: "hello world", op: "contains", right: "lo w" }, true],
    ["contains number in string", { left: "order 42", op: "contains", right: 42 }, true],
    ["contains array item (loose)", { left: [1, 2, 3], op: "contains", right: "2" }, true],
    ["contains array object", { left: [{ id: 1 }], op: "contains", right: { id: 1 } }, true],
    ["contains missing item", { left: ["a"], op: "contains", right: "b" }, false],
    ["contains on null", { left: null, op: "contains", right: "a" }, false],
    ["notContains substring", { left: "hello", op: "notContains", right: "z" }, true],
    ["notContains present item", { left: ["a", "b"], op: "notContains", right: "a" }, false],
    ["startsWith", { left: "Acme Corp", op: "startsWith", right: "Acme" }, true],
    ["startsWith no", { left: "Acme Corp", op: "startsWith", right: "Corp" }, false],
    ["endsWith", { left: "jane@acme.com", op: "endsWith", right: "@acme.com" }, true],
    ["endsWith on number", { left: 1234, op: "endsWith", right: "34" }, true],
    ["startsWith on object is false", { left: { a: 1 }, op: "startsWith", right: "a" }, false],
    ["in list", { left: "won", op: "in", right: ["won", "lost"] }, true],
    ["in list loose", { left: 3, op: "in", right: ["1", "3"] }, true],
    ["not in list", { left: "open", op: "in", right: ["won", "lost"] }, false],
    ["in string", { left: "ll", op: "in", right: "hello" }, true],
    ["in non-list", { left: 1, op: "in", right: 1 }, false],

    // emptiness & booleans
    ["isEmpty null", { left: null, op: "isEmpty" }, true],
    ["isEmpty undefined", { left: undefined, op: "isEmpty" }, true],
    ["isEmpty empty string", { left: "", op: "isEmpty" }, true],
    ["isEmpty empty array", { left: [], op: "isEmpty" }, true],
    ["isEmpty empty object", { left: {}, op: "isEmpty" }, true],
    ["isEmpty zero is not empty", { left: 0, op: "isEmpty" }, false],
    ["isEmpty false is not empty", { left: false, op: "isEmpty" }, false],
    ["isEmpty whitespace is not empty", { left: " ", op: "isEmpty" }, false],
    ["isNotEmpty string", { left: "x", op: "isNotEmpty" }, true],
    ["isNotEmpty empty array", { left: [], op: "isNotEmpty" }, false],
    ["isTrue true", { left: true, op: "isTrue" }, true],
    ["isTrue 'true'", { left: "true", op: "isTrue" }, true],
    ["isTrue 1 is not true", { left: 1, op: "isTrue" }, false],
    ["isFalse false", { left: false, op: "isFalse" }, true],
    ["isFalse 'false'", { left: "false", op: "isFalse" }, true],
    ["isFalse null is not false", { left: null, op: "isFalse" }, false],
  ];

  it.each(cases)("%s", (_name, rule, expected) => {
    expect(one(rule)).toBe(expected);
  });

  it("treats an unknown operator as not matching", () => {
    expect(one({ left: 1, op: "matches" as never, right: 1 })).toBe(false);
  });
});

describe("evaluateRules: groups", () => {
  const T: Rule = { left: 1, op: "eq", right: 1 };
  const F: Rule = { left: 1, op: "eq", right: 2 };

  it("and requires every rule", () => {
    expect(evaluateRules({ combinator: "and", rules: [T, T] })).toBe(true);
    expect(evaluateRules({ combinator: "and", rules: [T, F] })).toBe(false);
  });

  it("or requires any rule", () => {
    expect(evaluateRules({ combinator: "or", rules: [F, T] })).toBe(true);
    expect(evaluateRules({ combinator: "or", rules: [F, F] })).toBe(false);
  });

  it("empty and matches, empty or does not", () => {
    expect(evaluateRules({ combinator: "and", rules: [] })).toBe(true);
    expect(evaluateRules({ combinator: "or", rules: [] })).toBe(false);
  });

  it("evaluates nested groups", () => {
    // stage = won AND (amount > 1000 OR vip)
    const g = (stage: string, amount: number, vip: boolean): RuleGroup => ({
      combinator: "and",
      rules: [
        { left: stage, op: "eq", right: "won" },
        {
          combinator: "or",
          rules: [
            { left: amount, op: "gt", right: 1000 },
            { left: vip, op: "isTrue" },
          ],
        },
      ],
    });
    expect(evaluateRules(g("won", 5000, false))).toBe(true);
    expect(evaluateRules(g("won", 10, true))).toBe(true);
    expect(evaluateRules(g("won", 10, false))).toBe(false);
    expect(evaluateRules(g("lost", 5000, true))).toBe(false);
  });

  it("evaluates deeply nested groups", () => {
    let g: RuleGroup = { combinator: "and", rules: [T] };
    for (let i = 0; i < 20; i++) {
      g = i % 2 ? { combinator: "and", rules: [T, g] } : { combinator: "or", rules: [F, g] };
    }
    expect(evaluateRules(g)).toBe(true);
    const inner = { combinator: "and", rules: [F] } satisfies RuleGroup;
    expect(
      evaluateRules({ combinator: "or", rules: [F, { combinator: "and", rules: [T, inner] }] }),
    ).toBe(false);
  });
});

describe("rule helpers", () => {
  it("build rules and groups", () => {
    expect(eq(ref("trigger.stage"), "won")).toEqual({
      left: { $ref: "trigger.stage" },
      op: "eq",
      right: "won",
    });
    expect(isEmpty("x")).toEqual({ left: "x", op: "isEmpty" });
    expect(and(eq(1, 1), or(gt(2, 1), isTrue(true)))).toEqual({
      combinator: "and",
      rules: [
        { left: 1, op: "eq", right: 1 },
        {
          combinator: "or",
          rules: [
            { left: 2, op: "gt", right: 1 },
            { left: true, op: "isTrue" },
          ],
        },
      ],
    });
  });

  it("cover every operator", () => {
    const rules = [
      eq(1, 1),
      neq(1, 2),
      gt(2, 1),
      gte(1, 1),
      lt(1, 2),
      lte(1, 1),
      contains("ab", "a"),
      notContains("ab", "c"),
      startsWith("ab", "a"),
      endsWith("ab", "b"),
      isIn("a", ["a"]),
      isEmpty(""),
      isNotEmpty("a"),
      isTrue(true),
      isFalse(false),
    ];
    expect(rules.map((r) => r.op)).toEqual([
      "eq",
      "neq",
      "gt",
      "gte",
      "lt",
      "lte",
      "contains",
      "notContains",
      "startsWith",
      "endsWith",
      "in",
      "isEmpty",
      "isNotEmpty",
      "isTrue",
      "isFalse",
    ]);
    expect(evaluateRules(and(...rules))).toBe(true);
  });
});

describe("looseEquals", () => {
  it("is exported for switch-style matching", () => {
    expect(looseEquals("7", 7)).toBe(true);
    expect(looseEquals("a", "b")).toBe(false);
  });
});

describe("RuleGroupSchema", () => {
  it("accepts nested groups", () => {
    const g = and(eq(1, 1), or(isEmpty(null)));
    expect(RuleGroupSchema.parse(g)).toEqual(g);
  });

  it("rejects unknown operators and combinators", () => {
    expect(
      RuleGroupSchema.safeParse({ combinator: "and", rules: [{ left: 1, op: "like" }] }).success,
    ).toBe(false);
    expect(RuleGroupSchema.safeParse({ combinator: "xor", rules: [] }).success).toBe(false);
  });
});
