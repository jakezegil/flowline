import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineNode, definePlugin } from "./define";
import { createRegistry } from "./registry";
import type { JSONSchema, RuleOperatorMeta } from "./types";
import { ui } from "./ui";

describe("ui({ operators })", () => {
  const operators: RuleOperatorMeta[] = [
    { id: "isUnassigned", label: "is unassigned", arity: "unary", types: ["string", "any"] },
    { id: "within", label: "is within", arity: "binary" },
  ];
  const node = defineNode({
    type: "t.rules",
    name: "Rules",
    input: z.object({
      op: ui(z.enum(["eq", "isUnassigned", "within"]), {
        label: "Operator",
        enumLabels: { isUnassigned: "is unassigned", within: "is within" },
        operators,
      }),
    }),
    run: () => ({}),
  });

  it("carries rule operator metadata into the manifest", () => {
    const manifest = createRegistry([
      definePlugin({ id: "t", name: "T", nodes: [node] }),
    ]).manifest();
    const props = manifest.nodes[0]?.input.properties as Record<string, JSONSchema>;
    expect(props.op?.["x-flowline"]).toEqual({
      label: "Operator",
      enumLabels: { isUnassigned: "is unassigned", within: "is within" },
      operators,
    });
  });
});
