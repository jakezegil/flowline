import { z } from "zod";
import { defineNode, definePlugin, defineTrigger } from "../src/define";
import { createRegistry } from "../src/registry";
import type { Step, WorkflowDoc } from "../src/types";
import { fields, ui } from "../src/ui";

/** Shared test fixtures: a registry exercising every branch/output kind, and a small valid doc. */

const Contact = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  age: z.number(),
  tags: z.array(z.string()),
  address: z.object({ city: z.string(), zip: z.string() }).nullable(),
  orders: z.array(z.object({ id: z.string(), total: z.number() })),
});

const contactCreated = defineTrigger({
  type: "crm.contactCreated",
  name: "Contact created",
  icon: "user-plus",
  kind: "event",
  event: "contact.created",
  config: z.object({
    source: ui(z.enum(["web", "import"]), { label: "Source" }).optional(),
  }),
  payload: z.object({ contactId: z.string(), source: z.enum(["web", "import"]) }),
});

const loadContact = defineNode({
  type: "crm.loadContact",
  name: "Load contact",
  icon: "user",
  input: z.object({ contactId: ui(z.string(), { label: "Contact" }) }),
  output: Contact,
  run: () => ({
    id: "c1",
    email: "a@b.c",
    name: "A",
    age: 1,
    tags: [],
    address: null,
    orders: [],
  }),
});

const sendEmail = defineNode({
  type: "crm.sendEmail",
  name: "Send email",
  icon: "mail",
  input: z.object({
    to: ui(z.string(), { label: "To" }),
    subject: ui(z.string().min(1).max(50), { label: "Subject" }),
    body: ui(z.string(), { label: "Body", multiline: true }),
    priority: ui(z.number().int().min(1).max(5), { label: "Priority" }).optional(),
    sendAt: ui(z.iso.datetime(), { label: "Send at" }).optional(),
    mode: ui(z.enum(["html", "text"]), { label: "Mode" }).optional(),
    cc: ui(z.array(z.string()), { label: "CC" }).optional(),
    headers: ui(z.object({ replyTo: ui(z.string(), { label: "Reply to" }) }), {
      label: "Headers",
    }).optional(),
    template: ui(z.string(), { label: "Template", literalOnly: true }).optional(),
  }),
  output: z.object({ messageId: z.string() }),
  run: () => ({ messageId: "m1" }),
});

const ifElse = defineNode({
  type: "test.ifElse",
  name: "If / else",
  icon: "split",
  input: z.object({ value: ui(z.boolean(), { label: "Value" }) }),
  output: z.object({ matched: z.boolean() }),
  branches: {
    kind: "static",
    branches: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
  },
  run: () => ({ matched: true }),
});

const switchNode = defineNode({
  type: "test.switch",
  name: "Switch",
  input: z.object({
    value: ui(z.string(), { label: "Value" }),
    cases: ui(z.array(z.object({ id: z.string(), label: z.string(), value: z.string() })), {
      label: "Cases",
      widget: "cases",
    }),
  }),
  branches: {
    kind: "fromConfig",
    configPath: "cases",
    idKey: "id",
    labelKey: "label",
    append: [{ id: "default", label: "Default" }],
  },
  run: () => ({}),
});

const each = defineNode({
  type: "test.each",
  name: "For each",
  icon: "repeat",
  input: z.object({ items: ui(z.array(z.unknown()), { label: "Items", refOnly: true }) }),
  output: z.object({ count: z.number(), results: z.array(z.unknown()) }),
  branches: { kind: "loop", itemsField: "items", branch: "body" },
  run: () => ({ count: 0, results: [] }),
});

const setFields = defineNode({
  type: "test.fields",
  name: "Set fields",
  input: z.object({ fields: fields() }),
  dynamicOutput: { kind: "fields", configPath: "fields" },
  run: () => ({}),
});

const callSub = defineNode({
  type: "test.sub",
  name: "Call sub-flow",
  input: z.object({
    workflowId: ui(z.string(), { label: "Workflow" }),
    input: ui(z.record(z.string(), z.unknown()), { label: "Input" }),
  }),
  dynamicOutput: { kind: "subflow", configPath: "workflowId" },
  run: () => ({}),
});

const untyped = defineNode({
  type: "test.untyped",
  name: "Untyped",
  input: z.object({}),
  run: () => ({}),
});

const manual = defineTrigger({
  type: "test.manual",
  name: "Manual",
  kind: "manual",
  config: z.object({ fields: fields() }),
  dynamicPayload: { kind: "fields", configPath: "fields" },
});

const hook = defineTrigger({
  type: "test.hook",
  name: "Webhook",
  kind: "webhook",
  config: z.object({ fields: fields() }),
  dynamicPayload: { kind: "webhook", configPath: "fields" },
});

const anyTrigger = defineTrigger({
  type: "test.any",
  name: "Anything",
  kind: "event",
  event: "any",
  config: z.object({}),
});

/** Registry with crm.* and test.* nodes and triggers. */
export const registry = createRegistry([
  definePlugin({
    id: "crm",
    name: "CRM",
    nodes: [loadContact, sendEmail],
    triggers: [contactCreated],
  }),
  definePlugin({
    id: "test",
    name: "Test",
    nodes: [ifElse, switchNode, each, setFields, callSub, untyped],
    triggers: [manual, hook, anyTrigger],
  }),
]);

/** The fixture manifest. */
export const manifest = registry.manifest();

/** Shorthand for building a step. */
export function step(
  id: string,
  type: string,
  config: Step["config"] = {},
  extra: Partial<Step> = {},
): Step {
  return { id, type, config, ...extra };
}

/** A valid doc: contactCreated → load → email(to: steps.load.email). */
export function fixtureDoc(): WorkflowDoc {
  return {
    id: "welcome",
    name: "Welcome",
    trigger: { type: "crm.contactCreated", config: {} },
    steps: [
      step("load", "crm.loadContact", { contactId: { $ref: "trigger.contactId" } }),
      step("email", "crm.sendEmail", {
        to: { $ref: "steps.load.email" },
        subject: { $tpl: "Hi {{ steps.load.name }}" },
        body: "Welcome!",
      }),
    ],
  };
}

/** A doc with trigger + the given steps. */
export function docWith(steps: Step[], trigger?: WorkflowDoc["trigger"]): WorkflowDoc {
  return {
    id: "wf",
    name: "WF",
    trigger: trigger ?? { type: "crm.contactCreated", config: {} },
    steps,
  };
}
