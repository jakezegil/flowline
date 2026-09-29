import { describe, expect, it } from "vitest";
import { derefSchema } from "../json-schema";
import type { JSONSchema } from "../types";
import { compactSchema } from "./compact-schema";
import { richManifest } from "./fixtures";

const m = richManifest();

function input(type: string): JSONSchema {
  const n = m.nodes.find((x) => x.type === type);
  if (!n) throw new Error(type);
  return n.input;
}

describe("compactSchema", () => {
  it("names the def a cycle points back to, and root for #", () => {
    const tree: JSONSchema = {
      type: "object",
      properties: { kids: { type: "array", items: { $ref: "#" } }, a: { $ref: "#/$defs/a~1b" } },
      $defs: { "a/b": { type: "object", properties: { self: { $ref: "#/$defs/a~1b" } } } },
    };
    expect(compactSchema(tree)).toEqual({
      type: "object",
      properties: {
        kids: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kids: { type: "array", items: { $ref: "#recursive:root" } },
              a: { type: "object", properties: { self: { $ref: "#recursive:a/b" } } },
            },
          },
        },
        a: { type: "object", properties: { self: { $ref: "#recursive:a/b" } } },
      },
    });
  });

  it("maps a draft-07 tuple to prefixItems, additionalItems to items", () => {
    const s: JSONSchema = {
      type: "array",
      items: [{ type: "string", title: "Name" }, { $ref: "#/definitions/n" }],
      additionalItems: false,
      definitions: { n: { type: "number" } },
    };
    expect(compactSchema(s)).toEqual({
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: false,
    });
    // A lone `additionalItems` (no tuple) means nothing, and is left out.
    expect(
      compactSchema({ type: "array", items: { type: "string" }, additionalItems: false }),
    ).toEqual({ type: "array", items: { type: "string" } });
  });

  it("past 20 000 chars, deeper subtrees become #truncated", () => {
    // A DAG of shared refs: each level refers to the next twice, so inlining doubles per level.
    const $defs: Record<string, JSONSchema> = { d18: { type: "string", description: "leaf" } };
    for (let i = 17; i >= 0; i--) {
      $defs[`d${i}`] = {
        type: "object",
        properties: { l: { $ref: `#/$defs/d${i + 1}` }, r: { $ref: `#/$defs/d${i + 1}` } },
      };
    }
    const dag: JSONSchema = { $ref: "#/$defs/d0", $defs };
    const t0 = performance.now();
    const c = compactSchema(dag);
    expect(performance.now() - t0).toBeLessThan(2000);
    const text = JSON.stringify(c);
    expect(text.length).toBeLessThanOrEqual(20_000);
    expect(text.length).toBeGreaterThan(5_000);
    expect(text).toContain('{"$ref":"#truncated"}');
    expect(text).not.toContain("leaf");
    expect(c.type).toBe("object");

    // Mutually recursive defs: every def refers to all the others.
    const names = Array.from({ length: 7 }, (_, i) => `m${i}`);
    const mutual: JSONSchema = {
      $ref: "#/$defs/m0",
      $defs: Object.fromEntries(
        names.map((n) => [
          n,
          {
            type: "object",
            properties: Object.fromEntries(
              names.filter((x) => x !== n).map((x) => [x, { $ref: `#/$defs/${x}` }]),
            ),
          },
        ]),
      ),
    };
    const t1 = performance.now();
    const mc = JSON.stringify(compactSchema(mutual));
    expect(performance.now() - t1).toBeLessThan(2000);
    expect(mc.length).toBeLessThanOrEqual(20_000);
    expect(mc).toContain("#truncated");

    // A small schema is never truncated.
    expect(JSON.stringify(compactSchema(input("flow.condition")))).not.toContain("#truncated");
  });

  it("a recursive $defs schema terminates, the cycle as #recursive", () => {
    const c = compactSchema(input("flow.condition"));
    const text = JSON.stringify(c);
    expect(text).not.toContain("$defs");
    expect(text).not.toContain("#/$defs");
    expect(c).toEqual({
      type: "object",
      properties: {
        rules: {
          type: "object",
          properties: {
            combinator: { type: "string", enum: ["and", "or"] },
            rules: {
              type: "array",
              items: {
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      left: { type: "string" },
                      op: {
                        type: "string",
                        enum: ["eq", "isUnassigned"],
                        "x-flowline": {
                          label: "Operator",
                          enumLabels: { isUnassigned: "is unassigned" },
                        },
                      },
                    },
                    required: ["left", "op"],
                  },
                  { $ref: "#recursive:__schema0" },
                ],
              },
            },
          },
          required: ["combinator", "rules"],
        },
      },
      required: ["rules"],
    });
  });

  it("keeps only label, widget and enumLabels of x-flowline, and drops titles", () => {
    const c = compactSchema({
      type: "object",
      title: "Root",
      properties: {
        // A property named `title` is kept: only the keyword is dropped.
        title: { type: "string", title: "T", "x-flowline": { label: "Title", widget: "text" } },
        hidden: { type: "string", "x-flowline": { hidden: true, secret: true } },
      },
    });
    expect(c).toEqual({
      type: "object",
      properties: {
        title: { type: "string", "x-flowline": { label: "Title", widget: "text" } },
        hidden: { type: "string" },
      },
    });
  });

  it("inlines a non-recursive $ref used twice", () => {
    const addr = { type: "object", properties: { city: { type: "string" } } };
    const c = compactSchema({
      type: "object",
      properties: { home: { $ref: "#/$defs/A" }, work: { $ref: "#/$defs/A", description: "Work" } },
      $defs: { A: addr },
    });
    expect(c).toEqual({
      type: "object",
      properties: { home: addr, work: { ...addr, description: "Work" } },
    });
  });

  it("an unresolvable $ref becomes {}", () => {
    expect(compactSchema({ type: "object", properties: { a: { $ref: "#/$defs/Nope" } } })).toEqual({
      type: "object",
      properties: { a: {} },
    });
  });

  it("does not modify its input", () => {
    const s = input("flow.condition");
    const before = JSON.stringify(s);
    compactSchema(s);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe("derefSchema", () => {
  it("resolves a local $ref against the root, keeping siblings", () => {
    const root: JSONSchema = { $defs: { A: { type: "string" } } };
    expect(derefSchema(root, { $ref: "#/$defs/A", description: "d" })).toEqual({
      type: "string",
      description: "d",
    });
    expect(derefSchema(root, { type: "number" })).toEqual({ type: "number" });
    expect(derefSchema(root, { $ref: "#/$defs/B" })).toEqual({});
  });
});
