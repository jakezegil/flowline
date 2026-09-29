import { describe, expect, test } from "vitest";
import { richManifest } from "./agent/fixtures";
import {
  copyName,
  createStep,
  defaultConfig,
  jsonEqual,
  replaceStepType,
  syncBranches,
} from "./step-factory";
import { FlowlineTreeError, findStep } from "./tree";
import type { NodeManifest, Step, WorkflowDoc } from "./types";

const m = richManifest();
const node = (type: string) => m.nodes.find((n) => n.type === type) as NodeManifest;

describe("defaultConfig", () => {
  test("takes each top-level default, cloned", () => {
    const tags = ["a"];
    const schema = {
      type: "object",
      properties: { tags: { type: "array", default: tags }, n: { type: "number" } },
    };
    const config = defaultConfig(schema);
    expect(config).toEqual({ tags: ["a"] });
    expect(config.tags).not.toBe(tags);
  });

  test("a schema without properties gives {}", () => {
    expect(defaultConfig({})).toEqual({});
  });
});

describe("syncBranches", () => {
  test("adds declared branches, keeps non-empty undeclared ones, returns the step when in sync", () => {
    const created = createStep("check", node("flow.if"));
    // biome-ignore lint/suspicious/noThenProperty: a branch ID, not a thenable
    expect(created.branches).toEqual({ then: [], else: [] });
    expect(syncBranches(created, node("flow.if"))).toBe(created);
    const child: Step = { id: "x", type: "flow.stop", config: {} };
    const extra = { ...created, branches: { ...created.branches, old: [child], gone: [] } };
    expect(syncBranches(extra, node("flow.if")).branches).toEqual({
      // biome-ignore lint/suspicious/noThenProperty: a branch ID, not a thenable
      then: [],
      else: [],
      old: [child],
    });
  });

  test("fromConfig branches follow the config", () => {
    const sw = createStep("sw", node("flow.switch"));
    expect(Object.keys(sw.branches ?? {})).toEqual(["default"]);
    const withCase = {
      ...sw,
      config: { ...sw.config, cases: [{ id: "a", label: "A", value: "a" }] },
    };
    expect(Object.keys(syncBranches(withCase, node("flow.switch")).branches ?? {})).toEqual([
      "a",
      "default",
    ]);
  });

  test("a node without branches drops empty undeclared branches", () => {
    const s: Step = { id: "d", type: "crm.getDeal", config: {}, branches: { gone: [] } };
    expect(syncBranches(s, node("crm.getDeal"))).toEqual({
      id: "d",
      type: "crm.getDeal",
      config: {},
    });
  });
});

describe("jsonEqual", () => {
  test("compares structurally", () => {
    expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonEqual(undefined, undefined)).toBe(true);
    expect(jsonEqual(null, undefined)).toBe(false);
  });
});

describe("replaceStepType", () => {
  const doc = (): WorkflowDoc => ({
    id: "w",
    name: "W",
    trigger: { type: "crm.dealStuckInStage", config: { stage: "p" } },
    steps: [
      {
        id: "check",
        type: "flow.if",
        name: "Check it",
        disabled: true,
        note: "Why",
        color: "blue",
        config: { value: true },
        branches: {
          // biome-ignore lint/suspicious/noThenProperty: a branch ID, not a thenable
          then: [{ id: "x", type: "flow.stop", config: {} }],
          else: [],
        },
      },
    ],
  });

  test("resets config and name, keeps ID, disabled, annotations and non-empty children", () => {
    const next = replaceStepType(doc(), "check", node("crm.getDeal"));
    expect(findStep(next, "check")?.step).toEqual({
      id: "check",
      type: "crm.getDeal",
      config: {},
      disabled: true,
      note: "Why",
      color: "blue",
      // biome-ignore lint/suspicious/noThenProperty: a branch ID, not a thenable
      branches: { then: [{ id: "x", type: "flow.stop", config: {} }] },
    });
  });

  test("an unknown step throws FlowlineTreeError", () => {
    expect(() => replaceStepType(doc(), "nope", node("crm.getDeal"))).toThrow(FlowlineTreeError);
  });
});

describe("copyName", () => {
  test('"(copy)", then "(copy 2)", "(copy 3)", stripping an existing suffix', () => {
    expect(copyName("Send email", new Set())).toBe("Send email (copy)");
    expect(copyName("Send email", new Set(["Send email (copy)"]))).toBe("Send email (copy 2)");
    expect(copyName("Send email (copy)", new Set(["Send email (copy)"]))).toBe(
      "Send email (copy 2)",
    );
    expect(
      copyName("Send email (copy 2)", new Set(["Send email (copy)", "Send email (copy 2)"])),
    ).toBe("Send email (copy 3)");
    expect(copyName("A (copy 2)", new Set(["A (copy)"]))).toBe("A (copy 2)");
    expect(copyName("A (copy 12)", new Set())).toBe("A (copy)");
    expect(copyName("A(copy)", new Set())).toBe("A(copy) (copy)");
  });
});
