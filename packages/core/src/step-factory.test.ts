import { describe, expect, test } from "vitest";
import { richManifest } from "./agent/fixtures";
import { createStep, defaultConfig, jsonEqual, syncBranches } from "./step-factory";
import type { NodeManifest, Step } from "./types";

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
