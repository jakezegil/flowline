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
                  { $ref: "#recursive" },
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
