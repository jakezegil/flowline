import {
  availableScope,
  branchesFor,
  createRegistry,
  type NodeManifest,
  outputSchemaFor,
  payloadSchemaFor,
  ref,
  type Step,
  type TriggerManifest,
  tpl,
  validateWorkflow,
  type WorkflowDoc,
  workflow,
} from "@flowkit/core";
import { describe, expect, it } from "vitest";
import {
  and,
  builtinPlugin,
  callSubflowNode,
  conditionNode,
  delayNode,
  eq,
  forEachNode,
  manualTrigger,
  scheduleTrigger,
  stopNode,
  subflowTrigger,
  switchNode,
  VERSION,
  waitForCallbackNode,
  webhookTrigger,
} from "./index";

const manifest = createRegistry([builtinPlugin]).manifest();
const node = (type: string) => manifest.nodes.find((n) => n.type === type) as NodeManifest;
const trigger = (type: string) => manifest.triggers.find((t) => t.type === type) as TriggerManifest;

describe("builtinPlugin", () => {
  it("is the core plugin", () => {
    expect(VERSION).toBe("0.1.0");
    expect(builtinPlugin.id).toBe("core");
    expect(manifest.plugins).toEqual([
      expect.objectContaining({ id: "core", name: "Built-in", icon: expect.any(String) }),
    ]);
  });

  it("registers every logic, timing and sub-flow node and every trigger", () => {
    expect(manifest.nodes.map((n) => n.type)).toEqual([
      "core.condition",
      "core.switch",
      "core.forEach",
      "core.stop",
      "core.delay",
      "core.waitForCallback",
      "core.callSubflow",
    ]);
    expect(manifest.triggers.map((t) => [t.type, t.kind])).toEqual([
      ["core.event", "event"],
      ["core.webhook", "webhook"],
      ["core.manual", "manual"],
      ["core.schedule", "schedule"],
      ["core.subflow", "subflow"],
    ]);
  });

  it("gives every node and trigger a name, description and icon, and nodes a category and summary", () => {
    for (const n of manifest.nodes) {
      expect(n, n.type).toMatchObject({
        name: expect.any(String),
        description: expect.stringMatching(/\.$/),
        icon: expect.any(String),
        category: expect.any(String),
        summary: expect.any(String),
      });
    }
    for (const t of manifest.triggers) {
      expect(t, t.type).toMatchObject({
        name: expect.any(String),
        description: expect.stringMatching(/\.$/),
        icon: expect.any(String),
      });
    }
  });

  it("labels every config field", () => {
    const schemas = [
      ...manifest.nodes.map((n) => [n.type, n.input] as const),
      ...manifest.triggers.map((t) => [t.type, t.config] as const),
    ];
    for (const [type, schema] of schemas) {
      for (const [key, prop] of Object.entries(
        (schema.properties ?? {}) as Record<string, { "x-flowkit"?: { label?: string } }>,
      )) {
        expect(prop["x-flowkit"]?.label, `${type}.${key}`).toEqual(expect.any(String));
      }
    }
  });

  it("carries the editor metadata the brief specifies", () => {
    expect(node("core.condition")).toMatchObject({
      summary: "If conditions match",
      branches: {
        kind: "static",
        branches: [
          { id: "if", label: "If" },
          { id: "else", label: "Else" },
        ],
      },
      input: { properties: { rules: { "x-flowkit": { widget: "rules" } } } },
    });
    expect(node("core.switch")).toMatchObject({
      branches: {
        kind: "fromConfig",
        configPath: "cases",
        idKey: "id",
        labelKey: "label",
        append: [{ id: "default", label: "Default" }],
      },
      input: { properties: { cases: { "x-flowkit": { widget: "cases" } } } },
    });
    expect(node("core.forEach")).toMatchObject({
      branches: { kind: "loop", itemsField: "items", branch: "body" },
      input: { properties: { items: { "x-flowkit": { refOnly: true } } } },
    });
    expect(node("core.waitForCallback").branches).toEqual({
      kind: "static",
      branches: [
        { id: "resumed", label: "Resumed" },
        { id: "timeout", label: "Timed out" },
      ],
    });
    expect(node("core.callSubflow")).toMatchObject({
      output: { kind: "subflow", configPath: "workflowId" },
      input: {
        properties: {
          workflowId: { "x-flowkit": { widget: "subflowSelect" } },
          input: { "x-flowkit": { widget: "subflowInput" } },
        },
      },
    });
    expect(trigger("core.webhook")).toMatchObject({
      payload: { kind: "webhook", configPath: "fields" },
      config: { properties: { secret: { "x-flowkit": { secret: true } } } },
    });
    expect(trigger("core.manual").payload).toEqual({ kind: "fields", configPath: "fields" });
    expect(trigger("core.subflow").payload).toEqual({ kind: "fields", configPath: "input" });
  });

  it("types the forEach output as { count, results }", () => {
    const out = node("core.forEach").output;
    expect(out).toMatchObject({
      kind: "schema",
      schema: {
        type: "object",
        properties: { count: { type: "number" }, results: { type: "array" } },
      },
    });
  });

  it("exports each definition", () => {
    const nodes = [
      conditionNode,
      switchNode,
      forEachNode,
      stopNode,
      delayNode,
      waitForCallbackNode,
      callSubflowNode,
    ];
    expect(nodes.every((n) => builtinPlugin.nodes?.includes(n))).toBe(true);
  });
});

describe("core.switch branches in the manifest", () => {
  const step: Step = {
    id: "route",
    type: "core.switch",
    config: {
      value: { $ref: "trigger.tier" },
      cases: [
        { id: "gold", label: "Gold", value: "gold" },
        { id: "silver", label: "Silver", value: "silver" },
      ],
    },
    branches: { gold: [], silver: [], default: [] },
  };

  it("lists one branch per case plus Default", () => {
    expect(branchesFor(node("core.switch"), step)).toEqual([
      { id: "gold", label: "Gold" },
      { id: "silver", label: "Silver" },
      { id: "default", label: "Default" },
    ]);
  });

  it("lets the validator reject branches that aren't cases", () => {
    const doc: WorkflowDoc = {
      id: "wf",
      name: "Wf",
      trigger: { type: "core.manual", config: { fields: [{ name: "tier", type: "string" }] } },
      steps: [{ ...step, branches: { gold: [], bronze: [] } }],
    };
    const issues = validateWorkflow(doc, manifest);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: "branch.unknown", severity: "error", stepId: "route" }),
    );
    expect(validateWorkflow({ ...doc, steps: [step] }, manifest)).toEqual([]);
  });
});

describe("core.callSubflow output", () => {
  const ctx = {
    subflows: {
      "get-or-create": {
        name: "Get or create contact",
        input: {
          type: "object",
          properties: { email: { type: "string" } },
          required: ["email"],
        },
        output: {
          type: "object",
          properties: { contactId: { type: "string" }, created: { type: "boolean" } },
          additionalProperties: false,
        },
      },
    },
  };
  const doc = workflow("parent", { name: "Parent" })
    .trigger(manualTrigger, { fields: [{ name: "email", type: "string", required: true }] })
    .step("call", callSubflowNode, {
      workflowId: "get-or-create",
      input: { email: ref("trigger.email") },
    })
    .step("halt", stopNode, { reason: tpl("Contact {{steps.call.contactId}}") })
    .build();

  it("is typed from ValidationContext.subflows", () => {
    const call = doc.steps[0] as Step;
    expect(outputSchemaFor(node("core.callSubflow"), call, ctx)).toBe(
      ctx.subflows["get-or-create"].output,
    );
    const scope = availableScope(doc, "halt", manifest, ctx);
    expect(scope.find((e) => e.refBase === "steps.call")?.schema).toEqual(
      ctx.subflows["get-or-create"].output,
    );
    expect(validateWorkflow(doc, manifest, ctx)).toEqual([]);
  });

  it("lets the validator catch references to fields the sub-flow doesn't output", () => {
    const bad = structuredClone(doc);
    (bad.steps[1] as Step).config.reason = { $tpl: "{{steps.call.contactID}}" };
    expect(validateWorkflow(bad, manifest, ctx)).toContainEqual(
      expect.objectContaining({ code: "ref.unresolved", stepId: "halt" }),
    );
  });

  it("checks the input mapping against the sub-flow's input", () => {
    const bad = structuredClone(doc);
    (bad.steps[0] as Step).config.input = {};
    expect(validateWorkflow(bad, manifest, ctx)).toContainEqual(
      expect.objectContaining({ code: "config.required", stepId: "call" }),
    );
  });
});

describe("validation of built-in configs", () => {
  it("checks references inside condition rules", () => {
    const doc = workflow("wf")
      .trigger(manualTrigger, { fields: [{ name: "stage", type: "string" }] })
      .step(
        "check",
        conditionNode,
        { rules: and(eq(ref("trigger.stage"), "won")) },
        {
          if: (b) => b.step("wait", delayNode, { duration: "2d" }),
          else: (b) => b.step("halt", stopNode, { reason: "Not won" }),
        },
      )
      .build();
    expect(validateWorkflow(doc, manifest)).toEqual([]);
    const bad = structuredClone(doc);
    (bad.steps[0] as Step).config.rules = and(eq(ref("steps.nope.stage"), "won")) as never;
    expect(validateWorkflow(bad, manifest)).toContainEqual(
      expect.objectContaining({ code: "ref.unresolved", stepId: "check" }),
    );
  });

  it("types loop.item from the forEach items", () => {
    const doc = workflow("wf")
      .trigger(webhookTrigger, { fields: [{ name: "contacts", type: "array" }] })
      .step(
        "each",
        forEachNode,
        { items: ref("trigger.body.contacts") },
        {
          body: (b) => b.step("halt", stopNode, { reason: tpl("{{loop.item.name}}") }),
        },
      )
      .build();
    expect(validateWorkflow(doc, manifest)).toEqual([]);
    const literal = structuredClone(doc);
    (literal.steps[0] as Step).config.items = [1, 2];
    expect(validateWorkflow(literal, manifest)).toContainEqual(
      expect.objectContaining({ code: "config.invalid", stepId: "each", field: "items" }),
    );
  });

  it("flags a malformed delay duration", () => {
    const doc: WorkflowDoc = {
      id: "wf",
      name: "Wf",
      trigger: { type: "core.manual", config: {} },
      steps: [{ id: "wait", type: "core.delay", config: { duration: "2 days" } }],
    };
    expect(validateWorkflow(doc, manifest)).toContainEqual(
      expect.objectContaining({ code: "config.invalid", stepId: "wait", field: "duration" }),
    );
  });
});

describe("triggers", () => {
  it("core.webhook payload is { body: <fields>, headers }", () => {
    const schema = payloadSchemaFor(trigger("core.webhook"), {
      type: "core.webhook",
      config: { fields: [{ name: "email", type: "string", required: true }] },
    });
    expect(schema).toMatchObject({
      type: "object",
      properties: {
        body: { type: "object", properties: { email: { type: "string" } }, required: ["email"] },
        headers: { type: "object" },
      },
    });
  });

  it("core.manual and core.subflow payloads come from their declared fields", () => {
    const fields = [{ name: "n", type: "number" }];
    expect(
      payloadSchemaFor(trigger("core.manual"), { type: "core.manual", config: { fields } }),
    ).toMatchObject({ properties: { n: { type: "number" } } });
    expect(
      payloadSchemaFor(trigger("core.subflow"), {
        type: "core.subflow",
        config: { input: fields, output: [] },
      }),
    ).toMatchObject({ properties: { n: { type: "number" } } });
  });

  it("core.schedule defaults to UTC and rejects unknown time zones and malformed crons", () => {
    expect(scheduleTrigger.config.parse({ cron: "0 9 * * 1-5" })).toEqual({
      cron: "0 9 * * 1-5",
      timezone: "UTC",
    });
    expect(
      scheduleTrigger.config.safeParse({ cron: "0 9 * * *", timezone: "Europe/Berlin" }).success,
    ).toBe(true);
    expect(
      scheduleTrigger.config.safeParse({ cron: "0 9 * * *", timezone: "Mars/Olympus" }).error
        ?.issues[0]?.message,
    ).toBe('Unknown time zone "Mars/Olympus"');
    expect(scheduleTrigger.config.safeParse({ cron: "every day" }).success).toBe(false);
    expect(scheduleTrigger.payload?.parse({ firedAt: "2026-01-01T09:00:00.000Z" })).toEqual({
      firedAt: "2026-01-01T09:00:00.000Z",
    });
  });

  it("core.subflow and core.webhook field lists default to empty", () => {
    expect(subflowTrigger.config.parse({})).toEqual({ input: [], output: [] });
    expect(webhookTrigger.config.parse({})).toEqual({ fields: [] });
    expect(manualTrigger.config.parse({})).toEqual({ fields: [] });
  });
});
