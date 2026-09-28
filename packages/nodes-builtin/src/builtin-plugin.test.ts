import {
  createRegistry,
  FatalError,
  FlowlineDefinitionError,
  type JSONSchema,
  type NodeDefinition,
  type NodeManifest,
  ref,
  validateWorkflow,
  type WorkflowDoc,
} from "@flowlinejs/core";
import { describe, expect, it } from "vitest";
import { fakeContext } from "../test/fake-context";
import {
  and,
  builtinPlugin,
  type CustomOperator,
  conditionNode,
  createBuiltinPlugin,
  custom,
  eq,
  loosely,
  switchNode,
} from "./index";

const ctx = fakeContext();

const isUnassigned: CustomOperator = {
  id: "isUnassigned",
  label: "is unassigned",
  arity: "unary",
  types: ["string", "object", "any"],
  evaluate: (left) => left === null || left === undefined || left === "",
};
const within: CustomOperator = {
  id: "within",
  label: "is within",
  arity: "binary",
  types: ["number"],
  evaluate: (left, right) =>
    Array.isArray(right) &&
    typeof left === "number" &&
    left >= Number(right[0]) &&
    left <= Number(right[1]),
};

const manifestOf = (plugin = builtinPlugin) => createRegistry([plugin]).manifest();
const nodeIn = (plugin: typeof builtinPlugin, type: string) =>
  manifestOf(plugin).nodes.find((n) => n.type === type) as NodeManifest;
type Props = Record<string, JSONSchema>;
/** The condition's top-level rules schema and its rule `op` schema, from the manifest. */
const conditionSchemas = (plugin: typeof builtinPlugin) => {
  const rules = (nodeIn(plugin, "core.condition").input.properties as Props).rules as JSONSchema;
  const items = ((rules.properties as Props).rules as JSONSchema).items as JSONSchema;
  const rule = (items.anyOf as JSONSchema[])[0] as JSONSchema;
  return { rules, op: (rule.properties as Props).op as JSONSchema };
};
const switchCompare = (plugin: typeof builtinPlugin) =>
  (nodeIn(plugin, "core.switch").input.properties as Props).compare as JSONSchema;

/** Runs the plugin's own node instance, as the engine would after parsing the config. */
const run = async (plugin: typeof builtinPlugin, type: string, config: unknown) => {
  const node = plugin.nodes?.find((n) => n.type === type) as NodeDefinition;
  return node.run({ input: node.input.parse(config), ctx });
};

describe("builtinPlugin", () => {
  it("is createBuiltinPlugin(): loose, no custom operators", () => {
    expect(manifestOf(builtinPlugin)).toEqual(manifestOf(createBuiltinPlugin()));
    const { rules, op } = conditionSchemas(builtinPlugin);
    expect((rules.properties as Props).compare).toMatchObject({
      enum: ["strict", "loose"],
      default: "loose",
    });
    expect(switchCompare(builtinPlugin)).toMatchObject({ default: "loose" });
    expect(op["x-flowline"]).not.toHaveProperty("operators");
  });

  it("keeps conditionNode and switchNode as its loose instances", () => {
    expect(builtinPlugin.nodes).toContain(conditionNode);
    expect(builtinPlugin.nodes).toContain(switchNode);
  });
});

describe("createBuiltinPlugin({ compare })", () => {
  const strict = createBuiltinPlugin({ compare: "strict" });

  it("is the core plugin with fresh condition and switch instances", () => {
    expect(strict.id).toBe("core");
    expect(strict.nodes?.map((n) => n.type)).toEqual(builtinPlugin.nodes?.map((n) => n.type));
    expect(strict.nodes).not.toContain(conditionNode);
    expect(strict.nodes).not.toContain(switchNode);
  });

  it("publishes the default compare mode in the manifest", () => {
    const { rules } = conditionSchemas(strict);
    expect((rules.properties as Props).compare?.default).toBe("strict");
    expect(switchCompare(strict).default).toBe("strict");
  });

  it("evaluates a condition without compare strictly", async () => {
    expect(await run(strict, "core.condition", { rules: and(eq(5, "5")) })).toMatchObject({
      branch: "else",
    });
    expect(await run(builtinPlugin, "core.condition", { rules: and(eq(5, "5")) })).toMatchObject({
      branch: "if",
    });
  });

  it('evaluates a condition with compare: "loose" loosely', async () => {
    expect(await run(strict, "core.condition", { rules: loosely(and(eq(5, "5"))) })).toMatchObject({
      branch: "if",
    });
  });

  it("evaluates a switch without compare strictly, and with compare: loose loosely", async () => {
    const cases = [{ id: "five", label: "Five", value: "5" }];
    expect(await run(strict, "core.switch", { value: 5, cases })).toMatchObject({
      branch: "default",
    });
    expect(await run(strict, "core.switch", { value: 5, cases, compare: "loose" })).toMatchObject({
      branch: "five",
    });
  });
});

describe("createBuiltinPlugin({ operators })", () => {
  const plugin = createBuiltinPlugin({ operators: [isUnassigned, within] });

  it("offers them in the manifest: op enum, enumLabels and ui.operators", () => {
    const { op } = conditionSchemas(plugin);
    expect(op.enum).toEqual([
      ...(conditionSchemas(builtinPlugin).op.enum as string[]),
      "isUnassigned",
      "within",
    ]);
    expect(op["x-flowline"]).toEqual({
      label: "Operator",
      enumLabels: { isUnassigned: "is unassigned", within: "is within" },
      operators: [
        {
          id: "isUnassigned",
          label: "is unassigned",
          arity: "unary",
          types: ["string", "object", "any"],
        },
        { id: "within", label: "is within", arity: "binary", types: ["number"] },
      ],
    });
  });

  it("offers them in nested groups too", () => {
    const text = JSON.stringify(nodeIn(plugin, "core.condition").input.$defs);
    expect(text).toContain('"isUnassigned"');
  });

  it("evaluates them in core.condition", async () => {
    const rules = and(custom("isUnassigned", null), custom("within", 5, [1, 10]));
    expect(await run(plugin, "core.condition", { rules })).toMatchObject({ branch: "if" });
    const miss = and(custom("within", 50, [1, 10]));
    expect(await run(plugin, "core.condition", { rules: miss })).toMatchObject({ branch: "else" });
  });

  it("validates docs using them against the plugin's manifest only", () => {
    const doc: WorkflowDoc = {
      id: "wf",
      name: "Wf",
      trigger: { type: "core.manual", config: {} },
      steps: [
        {
          id: "check",
          type: "core.condition",
          config: { rules: and(custom("isUnassigned", ref("trigger.owner"))) as never },
          branches: { if: [], else: [] },
        },
      ],
    };
    expect(validateWorkflow(doc, manifestOf(plugin))).toEqual([]);
    expect(validateWorkflow(doc, manifestOf(builtinPlugin))).not.toEqual([]);
  });

  it("fails the step fatally, naming the operator, when one throws", async () => {
    const boom = createBuiltinPlugin({
      operators: [
        {
          id: "boom",
          label: "boom",
          arity: "unary",
          evaluate: () => {
            throw new Error("host bug");
          },
        },
      ],
    });
    const result = run(boom, "core.condition", { rules: and(custom("boom", 1)) });
    await expect(result).rejects.toThrow(FatalError);
    await expect(result).rejects.toThrow(/"boom"/);
  });

  it("rejects duplicate and built-in operator ids", () => {
    expect(() => createBuiltinPlugin({ operators: [isUnassigned, isUnassigned] })).toThrow(
      FlowlineDefinitionError,
    );
    expect(() => createBuiltinPlugin({ operators: [{ ...isUnassigned, id: "contains" }] })).toThrow(
      FlowlineDefinitionError,
    );
    expect(() => createBuiltinPlugin({ operators: [{ ...isUnassigned, id: "contains" }] })).toThrow(
      /"contains"/,
    );
  });
});
