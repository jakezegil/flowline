import { describe, expect, test } from "vitest";
import { dropHiddenFields, hiddenFields, isFieldShown, showIfOf } from "./show-if";
import type { JSONSchema } from "./types";

const cond = (field: string, rest: object = {}) => ({
  "x-flowkit": { showIf: { field, ...rest } },
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
});
