import { describe, expect, test } from "vitest";
import { z } from "zod";
import { branch, defineNode, definePlugin, defineTrigger, FlowkitDefinitionError } from "./define";
import { createRegistry } from "./registry";
import type { JSONSchema } from "./types";
import { fields, secret, ui } from "./ui";

const loadContact = defineNode({
  type: "crm.loadContact",
  name: "Load contact",
  summary: "Load {{contactId}}",
  input: z.object({ contactId: ui(z.string(), { label: "Contact", widget: "crm.contactSelect" }) }),
  output: z.object({ id: z.string(), email: z.string().optional() }),
  run: ({ input }) => ({ id: input.contactId }),
});
const dealUpdated = defineTrigger({
  type: "crm.dealUpdated",
  name: "Deal updated",
  kind: "event",
  event: "deal.updated",
  config: z.object({ onlyStage: z.boolean().default(false) }),
  payload: z.object({ dealId: z.string() }),
});
const crm = definePlugin({
  id: "crm",
  name: "CRM",
  icon: "building",
  nodes: [loadContact],
  triggers: [dealUpdated],
});

const props = (s: JSONSchema) => s.properties as Record<string, JSONSchema>;

test("manifest carries JSON Schema and ui meta", () => {
  const m = createRegistry([crm]).manifest();
  const n = m.nodes[0]!;
  expect(n.plugin).toBe("crm");
  expect(props(n.input).contactId!["x-flowkit"]).toEqual({
    label: "Contact",
    widget: "crm.contactSelect",
  });
  expect(n.output).toEqual({ kind: "schema", schema: expect.objectContaining({ type: "object" }) });
  expect(n.branches).toEqual({ kind: "none" });
  expect(n.summary).toBe("Load {{contactId}}");
  expect(JSON.parse(JSON.stringify(m))).toEqual(m); // serializable
});

test("rejects types outside plugin namespace", () => {
  expect(() =>
    createRegistry([definePlugin({ id: "x", name: "X", nodes: [loadContact] })]),
  ).toThrow(/crm.loadContact.*x\./);
  expect(() =>
    createRegistry([definePlugin({ id: "x", name: "X", triggers: [dealUpdated] })]),
  ).toThrow(/crm.dealUpdated.*x\./);
});

test("rejects duplicates", () => {
  const again = definePlugin({ id: "crm", name: "CRM 2", nodes: [loadContact] });
  expect(() => createRegistry([crm, again])).toThrow(FlowkitDefinitionError);
  expect(() => createRegistry([crm, again])).toThrow(/crm/);
  const dupNode = definePlugin({ id: "crm", name: "CRM", nodes: [loadContact, loadContact] });
  expect(() => createRegistry([dupNode])).toThrow(/Duplicate.*crm\.loadContact/);
  const clash = defineTrigger({
    type: "crm.loadContact",
    name: "Clash",
    kind: "manual",
    config: z.object({}),
  });
  expect(() =>
    createRegistry([
      definePlugin({ id: "crm", name: "CRM", nodes: [loadContact], triggers: [clash] }),
    ]),
  ).toThrow(/Duplicate.*crm\.loadContact/);
});

test("rejects invalid plugin ids", () => {
  expect(() => createRegistry([definePlugin({ id: "a.b", name: "A" })])).toThrow(/plugin id/i);
  expect(() => createRegistry([definePlugin({ id: "", name: "A" })])).toThrow(/plugin id/i);
});

test("lookups and plugins", () => {
  const r = createRegistry([crm]);
  expect(r.plugins).toEqual([crm]);
  expect(r.getNode("crm.loadContact")).toBe(loadContact);
  expect(r.getNode("crm.nope")).toBeUndefined();
  expect(r.getTrigger("crm.dealUpdated")).toBe(dealUpdated);
  expect(r.getTrigger("crm.loadContact")).toBeUndefined();
});

test("manifest is memoized", () => {
  const r = createRegistry([crm]);
  expect(r.manifest()).toBe(r.manifest());
});

test("plugins and triggers in the manifest", () => {
  const m = createRegistry([crm]).manifest();
  expect(m.plugins).toEqual([{ id: "crm", name: "CRM", icon: "building" }]);
  const t = m.triggers[0]!;
  expect(t).toMatchObject({
    type: "crm.dealUpdated",
    plugin: "crm",
    name: "Deal updated",
    kind: "event",
    event: "deal.updated",
  });
  // config is an input-side schema: fields with defaults are not required
  expect(t.config.required).toBeUndefined();
  expect(props(t.config).onlyStage).toMatchObject({ type: "boolean", default: false });
  expect(t.payload).toEqual({
    kind: "schema",
    schema: expect.objectContaining({ properties: { dealId: { type: "string" } } }),
  });
});

test("defaults for output, payload, dynamic specs and branches", () => {
  const cond = defineNode({
    type: "logic.condition",
    name: "Condition",
    input: z.object({ value: z.boolean() }),
    branches: {
      kind: "static",
      branches: [
        { id: "if", label: "If" },
        { id: "else", label: "Else" },
      ],
    },
    run: ({ input }) => branch(input.value ? "if" : "else"),
  });
  const setFields = defineNode({
    type: "logic.setFields",
    name: "Set fields",
    input: z.object({ fields: fields() }),
    dynamicOutput: { kind: "fields", configPath: "fields" },
    run: () => ({}),
  });
  const hook = defineTrigger({
    type: "logic.webhook",
    name: "Webhook",
    kind: "webhook",
    config: z.object({ fields: fields() }),
    dynamicPayload: { kind: "webhook", configPath: "fields" },
  });
  const manual = defineTrigger({
    type: "logic.manual",
    name: "Manual",
    kind: "manual",
    config: z.object({}),
  });
  const m = createRegistry([
    definePlugin({
      id: "logic",
      name: "Logic",
      nodes: [cond, setFields],
      triggers: [hook, manual],
    }),
  ]).manifest();
  expect(m.nodes[0]!.branches).toEqual(cond.branches);
  // no declared output: any value (empty schema), never a stripping `z.object({})`
  expect(m.nodes[0]!.output).toEqual({ kind: "schema", schema: {} });
  expect(m.nodes[1]!.output).toEqual({ kind: "fields", configPath: "fields" });
  expect(props(m.nodes[1]!.input).fields!["x-flowkit"]).toEqual({ widget: "fields" });
  expect(m.triggers[0]!.payload).toEqual({ kind: "webhook", configPath: "fields" });
  // no declared payload: any value (empty schema), never a stripping `z.object({})`
  expect(m.triggers[1]!.payload).toEqual({ kind: "schema", schema: {} });
  expect(manual.payload).toBeUndefined();
  // optional descriptive keys are omitted, not set to undefined
  expect(Object.keys(m.nodes[0]!)).not.toContain("description");
  expect(Object.keys(m.triggers[1]!)).not.toContain("event");
});

describe("ui metadata survives JSON Schema conversion", () => {
  const shared = ui(z.string(), { label: "Same" });
  const node = defineNode({
    type: "t.n",
    name: "N",
    input: z.object({
      optional: ui(z.string(), { label: "Opt" }).optional(),
      defaulted: ui(z.string(), { label: "Def" }).default("x"),
      nullable: ui(z.string(), { label: "Nul" }).nullable(),
      nullableOptional: ui(z.string(), { label: "NO" }).nullable().optional(),
      wrappedOuter: ui(z.string().optional(), { label: "Outer" }),
      described: ui(z.string(), { label: "D" }).describe("A description"),
      nested: z.object({ inner: ui(z.number(), { widget: "slider" }) }),
      list: z.array(z.object({ q: ui(z.string(), { multiline: true }) })),
      token: secret(),
      reusedA: shared,
      reusedB: shared.optional(),
    }),
    run: () => ({}),
  });
  const input = createRegistry([definePlugin({ id: "t", name: "T", nodes: [node] })]).manifest()
    .nodes[0]!.input;
  const p = props(input);

  test.each([
    ["optional", { label: "Opt" }],
    ["defaulted", { label: "Def" }],
    ["nullable", { label: "Nul" }],
    ["nullableOptional", { label: "NO" }],
    ["wrappedOuter", { label: "Outer" }],
    ["described", { label: "D" }],
    ["token", { secret: true, widget: "secret" }],
    ["reusedA", { label: "Same" }],
    ["reusedB", { label: "Same" }],
  ])("%s", (key, meta) => {
    expect(p[key]!["x-flowkit"]).toEqual(meta);
  });

  test("nullable fields keep their anyOf shape without duplicated meta", () => {
    const anyOf = p.nullable!.anyOf as JSONSchema[];
    expect(anyOf).toEqual([{ type: "string" }, { type: "null" }]);
  });

  test("description sits beside meta", () => {
    expect(p.described!.description).toBe("A description");
  });

  test("nested object and array item properties", () => {
    expect(props(p.nested!).inner!["x-flowkit"]).toEqual({ widget: "slider" });
    const item = p.list!.items as JSONSchema;
    expect(props(item).q!["x-flowkit"]).toEqual({ multiline: true });
  });
});
