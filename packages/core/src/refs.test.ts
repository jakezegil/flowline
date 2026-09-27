import { describe, expect, test } from "vitest";
import {
  collectRefs,
  FlowkitRefError,
  formatRefPath,
  isRef,
  isTpl,
  parseRefPath,
  parseTemplate,
  type ResolveScope,
  renderTemplate,
  resolveValue,
} from "./refs";
import type { ValueExpr } from "./types";

describe("parseRefPath", () => {
  test("parses steps ref with array index and property path", () => {
    expect(parseRefPath("steps.load.emails[0].value")).toEqual({
      root: "steps",
      stepId: "load",
      segments: ["emails", 0, "value"],
    });
  });

  test("parses steps ref with no sub-path (whole output)", () => {
    expect(parseRefPath("steps.load")).toEqual({
      root: "steps",
      stepId: "load",
      segments: [],
    });
  });

  test("parses trigger ref alone (whole payload)", () => {
    expect(parseRefPath("trigger")).toEqual({
      root: "trigger",
      segments: [],
    });
  });

  test("parses trigger ref with path", () => {
    expect(parseRefPath("trigger.contact.name")).toEqual({
      root: "trigger",
      segments: ["contact", "name"],
    });
  });

  test("parses loop.item and loop.item.<path>", () => {
    expect(parseRefPath("loop.item")).toEqual({ root: "loop", segments: ["item"] });
    expect(parseRefPath("loop.item.email")).toEqual({ root: "loop", segments: ["item", "email"] });
  });

  test("parses loop.index", () => {
    expect(parseRefPath("loop.index")).toEqual({ root: "loop", segments: ["index"] });
  });

  test("parses run.id", () => {
    expect(parseRefPath("run.id")).toEqual({ root: "run", segments: ["id"] });
  });

  test("bracket string segment", () => {
    expect(parseRefPath('steps.load.a["b c"]')).toEqual({
      root: "steps",
      stepId: "load",
      segments: ["a", "b c"],
    });
  });

  test.each([
    "steps",
    "foo.bar",
    "steps.1x",
    "loop",
    "loop.foo",
    "loop.index.x",
    "run.other",
    "run",
    "",
  ])("throws FlowkitRefError on bad path %s", (bad) => {
    expect(() => parseRefPath(bad)).toThrow(FlowkitRefError);
  });
});

describe("formatRefPath", () => {
  test("round-trips", () => {
    const paths = [
      "steps.load.emails[0].value",
      "steps.load",
      "trigger",
      "trigger.contact.name",
      "loop.item.email",
      "loop.index",
      "run.id",
    ];
    for (const p of paths) {
      expect(formatRefPath(parseRefPath(p))).toBe(p);
    }
  });
});

describe("isRef / isTpl", () => {
  test("identify ref and tpl expressions", () => {
    expect(isRef({ $ref: "trigger.a" })).toBe(true);
    expect(isRef({ $tpl: "a" })).toBe(false);
    expect(isRef("plain")).toBe(false);
    expect(isTpl({ $tpl: "a" })).toBe(true);
    expect(isTpl({ $ref: "a" })).toBe(false);
  });
});

const scope: ResolveScope = {
  trigger: { name: "Ada", contact: { emails: ["a@x.com", "b@x.com"] } },
  steps: { load: { id: "c1", email: "ada@example.com" } },
  run: { id: "run_1" },
};

describe("resolveValue", () => {
  test("keeps a nested __proto__ key as plain own data", () => {
    const expr = JSON.parse('{"outer": {"__proto__": {"x": 1}}}');
    const out = resolveValue(expr, scope) as { outer: Record<string, unknown> };
    expect(Object.hasOwn(out.outer, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(out.outer)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect((out.outer as { x?: unknown }).x).toBeUndefined();
  });

  test("resolves literals as-is", () => {
    expect(resolveValue("hi", scope)).toBe("hi");
    expect(resolveValue(42, scope)).toBe(42);
    expect(resolveValue(true, scope)).toBe(true);
    expect(resolveValue(null, scope)).toBe(null);
  });

  test("resolves a $ref deeply", () => {
    expect(resolveValue({ $ref: "steps.load.email" }, scope)).toBe("ada@example.com");
    expect(resolveValue({ $ref: "trigger.contact.emails[1]" }, scope)).toBe("b@x.com");
    expect(resolveValue({ $ref: "run.id" }, scope)).toBe("run_1");
  });

  test("missing ref resolves to undefined", () => {
    expect(resolveValue({ $ref: "steps.missing.value" }, scope)).toBeUndefined();
  });

  test("resolves loop scope", () => {
    const loopScope: ResolveScope = { ...scope, loop: { item: { sku: "A1" }, index: 3 } };
    expect(resolveValue({ $ref: "loop.item.sku" }, loopScope)).toBe("A1");
    expect(resolveValue({ $ref: "loop.index" }, loopScope)).toBe(3);
  });

  test("$tpl resolves to a rendered string even with a single ref", () => {
    expect(resolveValue({ $tpl: "{{ trigger.name }}" }, scope)).toBe("Ada");
    expect(typeof resolveValue({ $tpl: "{{ trigger.name }}" }, scope)).toBe("string");
  });

  test("resolves nested arrays and objects of exprs deeply", () => {
    const expr: ValueExpr = {
      list: [{ $ref: "trigger.name" }, "literal", { nested: { $ref: "run.id" } }],
    };
    expect(resolveValue(expr, scope)).toEqual({
      list: ["Ada", "literal", { nested: "run_1" }],
    });
  });
});

describe("renderTemplate", () => {
  test("interpolates a ref", () => {
    expect(renderTemplate("Hi {{trigger.name}}!", scope)).toBe("Hi Ada!");
  });

  test("interpolates with surrounding whitespace", () => {
    expect(renderTemplate("Hi {{ trigger.name }}!", scope)).toBe("Hi Ada!");
  });

  test("missing ref renders as empty string", () => {
    expect(renderTemplate("Hi {{trigger.missing}}!", scope)).toBe("Hi !");
  });

  test("numbers and booleans render via String()", () => {
    const s: ResolveScope = { ...scope, steps: { load: { count: 3, ok: false } } };
    expect(renderTemplate("{{steps.load.count}}/{{steps.load.ok}}", s)).toBe("3/false");
  });

  test("null/undefined render as empty string", () => {
    const s: ResolveScope = { ...scope, steps: { load: { v: null } } };
    expect(renderTemplate("[{{steps.load.v}}]", s)).toBe("[]");
  });

  test("objects/arrays render via JSON.stringify", () => {
    const s: ResolveScope = { ...scope, steps: { load: { obj: { a: 1 }, arr: [1, 2] } } };
    expect(renderTemplate("{{steps.load.obj}}", s)).toBe('{"a":1}');
    expect(renderTemplate("{{steps.load.arr}}", s)).toBe("[1,2]");
  });

  test("escapes \\{{ as a literal", () => {
    expect(renderTemplate("Use \\{{ like this }}", scope)).toBe("Use {{ like this }}");
  });
});

describe("parseTemplate", () => {
  test("splits text and ref parts", () => {
    expect(parseTemplate("Hi {{trigger.name}}!")).toEqual([
      { text: "Hi " },
      { ref: "trigger.name" },
      { text: "!" },
    ]);
  });

  test("pure text with no refs", () => {
    expect(parseTemplate("just text")).toEqual([{ text: "just text" }]);
  });
});

describe("collectRefs", () => {
  test("finds refs at top level, nested in arrays/objects, and inside templates", () => {
    const expr: ValueExpr = {
      a: { $ref: "trigger.x" },
      list: [{ $tpl: "Hi {{trigger.name}} from {{steps.load.email}}" }, { $ref: "run.id" }],
      nested: { deeper: { $ref: "loop.item.sku" } },
    };
    const refs = collectRefs(expr);
    expect(refs).toEqual(
      expect.arrayContaining([
        "trigger.x",
        "trigger.name",
        "steps.load.email",
        "run.id",
        "loop.item.sku",
      ]),
    );
    expect(refs).toHaveLength(5);
  });

  test("no refs on plain literal", () => {
    expect(collectRefs("plain")).toEqual([]);
    expect(collectRefs(42)).toEqual([]);
  });
});
