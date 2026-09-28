import type { Manifest, NodeManifest, Step, WorkflowDoc } from "@flowline/core";

/**
 * Shared test fixtures: a hand-written JSON manifest (the editor only ever sees JSON) covering
 * plain, static-branch, config-driven-branch and loop nodes, plus doc builders.
 */

const S = "https://json-schema.org/draft/2020-12/schema";

const contactSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    email: { type: "string" },
    name: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["id", "email", "name", "tags"],
  additionalProperties: false,
};

const nodes: NodeManifest[] = [
  {
    type: "crm.loadContact",
    plugin: "crm",
    name: "Load contact",
    icon: "user",
    summary: "Load {{contactId}}",
    input: {
      $schema: S,
      type: "object",
      properties: { contactId: { type: "string", "x-flowline": { label: "Contact" } } },
      required: ["contactId"],
    },
    output: { kind: "schema", schema: contactSchema },
    branches: { kind: "none" },
  },
  {
    type: "crm.sendEmail",
    plugin: "crm",
    name: "Send email",
    icon: "mail",
    input: {
      $schema: S,
      type: "object",
      properties: {
        to: { type: "string", "x-flowline": { label: "To" } },
        subject: { type: "string", default: "Hello", "x-flowline": { label: "Subject" } },
        mode: { type: "string", enum: ["html", "text"], default: "html" },
        cc: { type: "array", items: { type: "string" }, default: [] },
      },
      required: ["to", "subject"],
    },
    output: {
      kind: "schema",
      schema: { type: "object", properties: { messageId: { type: "string" } } },
    },
    branches: { kind: "none" },
  },
  {
    type: "logic.condition",
    plugin: "logic",
    name: "Condition",
    icon: "split",
    input: {
      $schema: S,
      type: "object",
      properties: { value: { type: "boolean", default: true } },
      required: ["value"],
    },
    output: {
      kind: "schema",
      schema: { type: "object", properties: { matched: { type: "boolean" } } },
    },
    branches: {
      kind: "static",
      branches: [
        { id: "if", label: "If" },
        { id: "else", label: "Else" },
      ],
    },
  },
  {
    type: "logic.switch",
    plugin: "logic",
    name: "Switch",
    icon: "git-fork",
    input: {
      $schema: S,
      type: "object",
      properties: {
        value: { type: "string" },
        cases: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, label: { type: "string" } },
          },
          default: [{ id: "a", label: "A" }],
        },
      },
      required: ["value", "cases"],
    },
    output: { kind: "schema", schema: { type: "object", properties: {} } },
    branches: {
      kind: "fromConfig",
      configPath: "cases",
      idKey: "id",
      labelKey: "label",
      append: [{ id: "default", label: "Default" }],
    },
  },
  {
    type: "logic.forEach",
    plugin: "logic",
    name: "For each",
    icon: "repeat",
    input: {
      $schema: S,
      type: "object",
      properties: { items: { type: "array", items: {} } },
      required: ["items"],
    },
    output: {
      kind: "schema",
      schema: {
        type: "object",
        properties: { count: { type: "number" }, results: { type: "array", items: {} } },
      },
    },
    branches: { kind: "loop", itemsField: "items", branch: "body" },
  },
];

/** The fixture manifest. */
export const manifest: Manifest = {
  plugins: [
    { id: "crm", name: "CRM" },
    { id: "logic", name: "Logic" },
  ],
  nodes,
  triggers: [
    {
      type: "crm.contactCreated",
      plugin: "crm",
      name: "Contact created",
      kind: "event",
      event: "contact.created",
      config: { $schema: S, type: "object", properties: {} },
      payload: {
        kind: "schema",
        schema: {
          type: "object",
          properties: { contactId: { type: "string" } },
          required: ["contactId"],
        },
      },
    },
    {
      type: "logic.manual",
      plugin: "logic",
      name: "Manual",
      kind: "manual",
      config: {
        $schema: S,
        type: "object",
        properties: { fields: { type: "array", items: { type: "object" }, default: [] } },
      },
      payload: { kind: "fields", configPath: "fields" },
    },
  ],
};

/** Shorthand for building a step. */
export function step(
  id: string,
  type: string,
  config: Step["config"] = {},
  extra: Partial<Step> = {},
): Step {
  return { id, type, config, ...extra };
}

/** A doc with the contactCreated trigger and the given top-level steps. */
export function docWith(steps: Step[], id = "welcome"): WorkflowDoc {
  return { id, name: "Welcome", trigger: { type: "crm.contactCreated", config: {} }, steps };
}

/** A valid doc: contactCreated → load → email(to: steps.load.email). */
export function fixtureDoc(): WorkflowDoc {
  return docWith([
    step("load", "crm.loadContact", { contactId: { $ref: "trigger.contactId" } }),
    step("email", "crm.sendEmail", { to: { $ref: "steps.load.email" }, subject: "Hi" }),
  ]);
}

/** A doc with a condition (if: email, else: empty) and a loop (body: email) after it. */
export function branchyDoc(): WorkflowDoc {
  return docWith([
    step("load", "crm.loadContact", { contactId: { $ref: "trigger.contactId" } }),
    step(
      "cond",
      "logic.condition",
      { value: true },
      {
        branches: {
          if: [step("email", "crm.sendEmail", { to: { $ref: "steps.load.email" }, subject: "Hi" })],
          else: [],
        },
      },
    ),
    step(
      "each",
      "logic.forEach",
      { items: { $ref: "steps.load.tags" } },
      { branches: { body: [] } },
    ),
  ]);
}
