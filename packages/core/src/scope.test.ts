import { describe, expect, test } from "vitest";
import { docWith, manifest, step } from "../test/fixtures";
import { schemaAtPath } from "./json-schema";
import { availableScope } from "./scope";
import type { WorkflowDoc } from "./types";

const bases = (doc: WorkflowDoc, id: string | null) =>
  availableScope(doc, id, manifest).map((e) => e.refBase);

function branchyDoc(): WorkflowDoc {
  return docWith([
    step("load", "crm.loadContact", { contactId: { $ref: "trigger.contactId" } }),
    step(
      "cond",
      "test.ifElse",
      { value: true },
      {
        branches: {
          yes: [step("a", "test.untyped"), step("b", "test.untyped")],
          no: [step("c", "test.untyped")],
        },
      },
    ),
    step("after", "test.untyped"),
  ]);
}

describe("availableScope", () => {
  test("trigger and earlier siblings only", () => {
    const doc = branchyDoc();
    expect(bases(doc, "load")).toEqual(["trigger"]);
    expect(bases(doc, "cond")).toEqual(["trigger", "steps.load"]);
  });

  test("inside a branch: enclosing earlier siblings, the block, earlier branch siblings", () => {
    const doc = branchyDoc();
    expect(bases(doc, "a")).toEqual(["trigger", "steps.load", "steps.cond"]);
    expect(bases(doc, "b")).toEqual(["trigger", "steps.load", "steps.cond", "steps.a"]);
    expect(bases(doc, "c")).toEqual(["trigger", "steps.load", "steps.cond"]);
  });

  test("steps inside a branch are not visible after the rejoin", () => {
    expect(bases(branchyDoc(), "after")).toEqual(["trigger", "steps.load", "steps.cond"]);
  });

  test("null = end of doc (top-level steps only)", () => {
    expect(bases(branchyDoc(), null)).toEqual([
      "trigger",
      "steps.load",
      "steps.cond",
      "steps.after",
    ]);
  });

  test("unknown step id → trigger only", () => {
    expect(bases(branchyDoc(), "nope")).toEqual(["trigger"]);
  });

  test("entries carry kind, label, icon and schema", () => {
    const doc = branchyDoc();
    doc.steps[0]!.name = "Load the lead";
    const [trig, load, cond] = availableScope(doc, "after", manifest);
    expect(trig).toMatchObject({ kind: "trigger", label: "Contact created", icon: "user-plus" });
    expect(schemaAtPath(trig!.schema, ["contactId"])).toMatchObject({ type: "string" });
    expect(load).toMatchObject({
      kind: "step",
      stepId: "load",
      label: "Load the lead",
      icon: "user",
    });
    expect(cond).toMatchObject({ kind: "step", stepId: "cond", label: "If / else" });
    expect(schemaAtPath(cond!.schema, ["matched"])).toMatchObject({ type: "boolean" });
  });

  test("loop.item is typed from the items array element; loop output only after the loop", () => {
    const doc = docWith([
      step("load", "crm.loadContact", { contactId: "c1" }),
      step(
        "each",
        "test.each",
        { items: { $ref: "steps.load.orders" } },
        {
          branches: { body: [step("x", "test.untyped"), step("y", "test.untyped")] },
        },
      ),
      step("after", "test.untyped"),
    ]);
    const inside = availableScope(doc, "y", manifest);
    expect(inside.map((e) => e.refBase)).toEqual(["trigger", "steps.load", "loop", "steps.x"]);
    const loop = inside.find((e) => e.kind === "loop")!;
    expect(loop.stepId).toBe("each");
    expect(schemaAtPath(loop.schema, ["item", "total"])).toMatchObject({ type: "number" });
    expect(schemaAtPath(loop.schema, ["index"])).toEqual({ type: "number" });
    expect(bases(doc, "after")).toEqual(["trigger", "steps.load", "steps.each"]);
  });

  test("loop.item is any when items isn't a resolvable array ref", () => {
    const doc = docWith([
      step(
        "each",
        "test.each",
        { items: { $ref: "trigger.contactId" } },
        {
          branches: { body: [step("x", "test.untyped")] },
        },
      ),
    ]);
    const loop = availableScope(doc, "x", manifest).find((e) => e.kind === "loop")!;
    expect(schemaAtPath(loop.schema, ["item"])).toEqual({});
  });

  test("nested loops: innermost loop wins", () => {
    const doc = docWith([
      step("load", "crm.loadContact", { contactId: "c1" }),
      step(
        "outer",
        "test.each",
        { items: { $ref: "steps.load.orders" } },
        {
          branches: {
            body: [
              step(
                "inner",
                "test.each",
                { items: { $ref: "steps.load.tags" } },
                {
                  branches: { body: [step("x", "test.untyped")] },
                },
              ),
            ],
          },
        },
      ),
    ]);
    const scope = availableScope(doc, "x", manifest);
    expect(scope.filter((e) => e.kind === "loop")).toHaveLength(1);
    const loop = scope.find((e) => e.kind === "loop")!;
    expect(loop.stepId).toBe("inner");
    expect(schemaAtPath(loop.schema, ["item"])).toMatchObject({ type: "string" });
  });

  test("unknown node and trigger types contribute any schemas", () => {
    const doc = docWith([step("u", "nope.node"), step("v", "test.untyped")], {
      type: "nope.trigger",
      config: {},
    });
    const scope = availableScope(doc, "v", manifest);
    expect(scope.map((e) => [e.refBase, e.schema])).toEqual([
      ["trigger", {}],
      ["steps.u", {}],
    ]);
  });
});
