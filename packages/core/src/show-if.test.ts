import { describe, expect, test } from "vitest";
import { dropHiddenFields, hiddenFields, isFieldShown, showIfOf, showIfProblems } from "./show-if";
import type { JSONSchema } from "./types";

const cond = (field: string, rest: object = {}) => ({
  "x-flowline": { showIf: { field, ...rest } },
});

const schema: JSONSchema = {
  type: "object",
  properties: {
    kind: { type: "string", default: "none" },
    body: { ...cond("kind", { notEquals: "none" }) },
    note: { type: "string", ...cond("body") },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { on: { type: "boolean" }, level: { type: "number", ...cond("on") } },
      },
    },
  },
};

describe("showIf", () => {
  test("isFieldShown: equals, notEquals, set, defaults and references", () => {
    expect(isFieldShown(undefined, {})).toBe(true);
    expect(isFieldShown({ field: "k", equals: ["a", "b"] }, { k: "b" })).toBe(true);
    expect(isFieldShown({ field: "k", notEquals: "a" }, { k: "a" })).toBe(false);
    expect(isFieldShown({ field: "k" }, { k: "" })).toBe(false);
    expect(isFieldShown({ field: "k", equals: "a" }, {}, { k: { default: "a" } })).toBe(true);
    expect(isFieldShown({ field: "k", equals: "a" }, { k: { $ref: "trigger.k" } })).toBe(true);
  });

  test("hiddenFields resolves chains: a hidden sibling counts as unset", () => {
    expect(hiddenFields({}, schema)).toEqual(new Set(["body", "note"]));
    expect(hiddenFields({ body: "x", note: "n" }, schema)).toEqual(new Set(["body", "note"]));
    expect(hiddenFields({ kind: "json", body: "x" }, schema)).toEqual(new Set());
    expect(hiddenFields({ kind: "json" }, schema)).toEqual(new Set(["note"]));
  });

  test("showIfOf follows $refs and nullable wrappers", () => {
    const root: JSONSchema = { $defs: { B: { type: "string", ...cond("k") } } };
    expect(showIfOf({ $ref: "#/$defs/B" }, root)).toEqual({ field: "k" });
    expect(showIfOf({ anyOf: [{ type: "string", ...cond("k") }, { type: "null" }] })).toEqual({
      field: "k",
    });
    expect(
      showIfOf({ anyOf: [{ type: "string", ...cond("k") }, { type: "number" }] }),
    ).toBeUndefined();
  });

  test("dropHiddenFields removes hidden values at every level, without mutating", () => {
    const value = {
      kind: "none",
      body: { a: 1 },
      note: "n",
      items: [
        { on: false, level: 3 },
        { on: true, level: 4 },
      ],
    };
    const copy = structuredClone(value);
    expect(dropHiddenFields(value, schema)).toEqual({
      kind: "none",
      items: [{ on: false }, { on: true, level: 4 }],
    });
    expect(value).toEqual(copy);
    expect(dropHiddenFields({ kind: "json", body: 1, note: "n" }, schema)).toEqual({
      kind: "json",
      body: 1,
      note: "n",
    });
  });

  const variant = (type: string, extra: object = {}): JSONSchema => ({
    type: "object",
    properties: {
      type: { type: "string", const: type },
      mode: { type: "string", default: "a" },
      ...extra,
    },
    required: ["type"],
  });

  test("dropHiddenFields picks a discriminated union's member as the validator does", () => {
    const union: JSONSchema = {
      type: "object",
      properties: {
        auth: {
          oneOf: [
            variant("key", { extra: { type: "string", ...cond("mode", { equals: "b" }) } }),
            variant("basic", { user: { type: "string", ...cond("mode", { equals: "a" }) } }),
          ],
        },
        byName: { type: "object", additionalProperties: variant("key", { x: cond("mode") }) },
      },
    };
    expect(
      dropHiddenFields(
        {
          auth: { type: "key", extra: "x" },
          byName: { a: { type: "key", mode: "", x: 1 }, b: { type: "key", mode: "on", x: 2 } },
        },
        union,
      ),
    ).toEqual({
      auth: { type: "key" },
      byName: { a: { type: "key", mode: "" }, b: { type: "key", mode: "on", x: 2 } },
    });
    expect(dropHiddenFields({ auth: { type: "basic", user: "u" } }, union)).toEqual({
      auth: { type: "basic", user: "u" },
    });
    // No member matches: left as is (the validator reports it).
    expect(dropHiddenFields({ auth: { type: "other", extra: 1 } }, union)).toEqual({
      auth: { type: "other", extra: 1 },
    });
  });

  test("showIfProblems rejects showIf where dropHiddenFields can't reach it", () => {
    const inner = {
      type: "object",
      properties: { m: { type: "string" }, x: { type: "string", ...cond("m") } },
    };
    const at = (s: object) => showIfProblems({ type: "object", properties: { p: s } });
    expect(at({ anyOf: [inner, { type: "number" }] })).toEqual([
      `"p.x" has showIf inside a union without a discriminator, which isn't supported`,
    ]);
    expect(at({ allOf: [inner] })).toEqual([
      `"p.x" has showIf inside an allOf, which isn't supported`,
    ]);
    expect(at({ type: "array", prefixItems: [inner] })).toEqual([
      `"p[].x" has showIf inside a tuple (prefixItems), which isn't supported`,
    ]);
    expect(at({ anyOf: [inner, { type: "null" }] })).toEqual([]);
    expect(
      at({ oneOf: [variant("a", { x: cond("mode") }), variant("b", { y: cond("mode") })] }),
    ).toEqual([]);
    expect(at({ type: "object", additionalProperties: inner })).toEqual([]);
  });
});
