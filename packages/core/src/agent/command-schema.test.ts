import { describe, expect, test } from "vitest";
import type { Manifest, NodeManifest } from "../types";
import { commandSchema, formatPath, opJsonSchema } from "./command-schema";
import { richManifest } from "./fixtures";

const m = richManifest();

describe("commandSchema", () => {
  test("is cached per manifest object and internal flag", () => {
    expect(commandSchema(m)).toBe(commandSchema(m));
    expect(commandSchema(m, { internal: false })).toBe(commandSchema(m, { internal: false }));
    expect(commandSchema(m, { internal: false })).not.toBe(commandSchema(m));
    expect(commandSchema()).toBe(commandSchema());
    expect(commandSchema({ ...m })).not.toBe(commandSchema(m));
  });

  test("accepts well-formed commands", () => {
    const s = commandSchema(m);
    for (const cmd of [
      { op: "addStep", at: { after: "a" }, type: "crm.getDeal", config: { dealId: "d" } },
      { op: "addStep", at: { in: { stepId: "a", branch: "then" }, index: 0 }, type: "flow.stop" },
      { op: "moveStep", id: "$1", to: { start: true } },
      { op: "removeStep", id: "a" },
      { op: "setConfig", id: "a", key: "k", value: null },
      { op: "setConfig", id: "a", key: "k", value: null, nullIsValue: true },
      { op: "setConfig", id: "a", config: { k: 1, gone: null } },
    ]) {
      expect(s.safeParse(cmd).success, JSON.stringify(cmd)).toBe(true);
    }
  });

  test("with a manifest, type is an enum of its node types", () => {
    const cmd = { op: "addStep", at: { start: true }, type: "nope.nope" };
    expect(commandSchema(m).safeParse(cmd).success).toBe(false);
    expect(commandSchema().safeParse(cmd).success).toBe(true);
  });

  test("strict: unknown keys fail, naming the key", () => {
    const r = commandSchema(m).safeParse({ op: "removeStep", id: "a", extra: 1 });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("extra");
  });

  test("nullIsValue is internal only", () => {
    const cmd = { op: "setConfig", id: "a", key: "k", value: null, nullIsValue: true };
    expect(commandSchema(m, { internal: true }).safeParse(cmd).success).toBe(true);
    expect(commandSchema(m, { internal: false }).safeParse(cmd).success).toBe(false);
  });

  test("nullIsValue on setTriggerConfig and setOutput is internal only, too", () => {
    for (const op of ["setTriggerConfig", "setOutput"]) {
      const cmd = { op, key: "k", value: null, nullIsValue: true };
      expect(commandSchema(m, { internal: true }).safeParse(cmd).success).toBe(true);
      expect(commandSchema(m, { internal: false }).safeParse(cmd).success).toBe(false);
      expect(JSON.stringify(opJsonSchema(m, op, []))).not.toContain("nullIsValue");
    }
  });

  test("the new ops parse in their documented forms", () => {
    const s = commandSchema(m);
    const trigger = m.triggers[0]?.type as string;
    for (const cmd of [
      { op: "duplicateStep", id: "a" },
      { op: "renameStep", id: "a", name: "" },
      { op: "renameStepId", id: "$1", newId: "b" },
      { op: "setType", id: "a", type: "crm.getDeal" },
      { op: "setDisabled", id: "a", disabled: false },
      { op: "setNote", id: "a", note: null },
      { op: "setColor", id: "a", color: "blue" },
      { op: "setColor", id: "a", color: null },
      { op: "setTrigger", type: trigger },
      { op: "setTrigger", type: trigger, config: { stage: "x", gone: null } },
      { op: "setTriggerConfig", key: "k", value: 1 },
      { op: "setTriggerConfig", config: { k: null } },
      { op: "setOutput", key: "k", value: { $ref: "steps.a.b" } },
      { op: "setOutput", config: { k: null } },
      { op: "renameWorkflow", name: "W" },
      { op: "addSection", first: "a", last: "b", title: "T", color: "gray" },
      { op: "addSection", first: "a", last: "a", title: "T", color: "gray", note: "n", id: "t" },
      { op: "updateSection", id: "t", note: null, first: "a" },
      { op: "removeSection", id: "$1" },
    ]) {
      expect(s.safeParse(cmd).success, JSON.stringify(cmd)).toBe(true);
    }
    for (const cmd of [
      { op: "setColor", id: "a", color: "red" },
      { op: "setTrigger", type: "nope.nope" },
      { op: "renameWorkflow", name: "  " },
      { op: "setNote", id: "a", note: "x".repeat(4001) },
      { op: "updateSection", id: "t", color: null },
      { op: "addSection", first: "a", last: "b", title: "T" },
    ]) {
      expect(s.safeParse(cmd).success, JSON.stringify(cmd)).toBe(false);
    }
  });
});

describe("opJsonSchema", () => {
  test("the addStep schema has the at property and fits 1500 chars", () => {
    const s = opJsonSchema(m, "addStep", []);
    expect((s.properties as Record<string, unknown>).at).toBeDefined();
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(1500);
    expect(JSON.stringify(s)).not.toContain("nullIsValue");
  });

  test("a path narrows the schema; a path past it stops at the deepest part", () => {
    const at = opJsonSchema(m, "addStep", ["at"]);
    expect(at.anyOf).toHaveLength(4);
    expect(opJsonSchema(m, "addStep", ["at", "in", "branch"])).toEqual({
      type: "string",
      minLength: 1,
    });
    expect(opJsonSchema(m, "setConfig", ["value"])).toEqual({ description: "Any JSON value" });
    expect(opJsonSchema(m, "removeStep", ["id", "deeper", 3])).toEqual({
      type: "string",
      minLength: 1,
    });
  });

  test("an unknown op gives the list of ops", () => {
    const s = opJsonSchema(m, "frobnicate", []);
    expect((s.properties as { op: { enum: string[] } }).op.enum).toEqual([
      "addStep",
      "moveStep",
      "removeStep",
      "setConfig",
      "duplicateStep",
      "renameStep",
      "renameStepId",
      "setType",
      "setDisabled",
      "setNote",
      "setColor",
      "setTrigger",
      "setTriggerConfig",
      "setOutput",
      "renameWorkflow",
      "addSection",
      "updateSection",
      "removeSection",
      "insertSteps",
      "replaceSteps",
      "duplicateSteps",
      "updateSteps",
      "replaceInConfig",
      "moveSteps",
      "removeSteps",
      "wrapSteps",
      "unwrapStep",
    ]);
  });

  test("a huge manifest still gives a hint of at most 1500 chars", () => {
    const many: NodeManifest[] = Array.from({ length: 400 }, (_, i) => ({
      type: `plugin${i}.someVeryLongNodeTypeName${i}`,
      plugin: `plugin${i}`,
      name: `Node ${i}`,
      input: { type: "object", properties: {} },
      output: { kind: "schema", schema: {} },
      branches: { kind: "none" },
    }));
    const big: Manifest = { ...m, nodes: many };
    const s = opJsonSchema(big, "addStep", []);
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(1500);
    expect((s.properties as Record<string, unknown>).at).toBeDefined();
  });
});

describe("formatPath", () => {
  test("dots for identifiers, brackets for indices and other keys", () => {
    expect(formatPath(["commands", 2, "config", "to"])).toBe("commands[2].config.to");
    expect(formatPath(["commands", 0, "config", "a-b", 1])).toBe('commands[0].config["a-b"][1]');
  });
});
