/**
 * Playground fixtures: a JSON manifest mirroring the built-in nodes (plugin "core") plus a fake
 * CRM plugin, and sample workflows. The editor only ever sees JSON, so no server code is needed.
 */
import type { Manifest, NodeManifest, Step, TriggerManifest, WorkflowDoc } from "@flowkit/core";

const S = "https://json-schema.org/draft/2020-12/schema";
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  $schema: S,
  type: "object",
  properties,
  required,
});
const str = (label: string, extra: Record<string, unknown> = {}) => ({
  type: "string",
  "x-flowkit": { label },
  ...extra,
});
const out = (properties: Record<string, unknown>) =>
  ({ kind: "schema", schema: { type: "object", properties } }) as const;

const contact = {
  id: { type: "string" },
  name: { type: "string" },
  email: { type: "string" },
  region: { type: "string" },
  tags: { type: "array", items: { type: "string" } },
};

const core: NodeManifest[] = [
  {
    type: "core.condition",
    plugin: "core",
    name: "Condition",
    icon: "split",
    category: "Flow",
    description: "Take one path when rules match, another when they don't",
    summary: "If conditions match",
    input: obj({ rules: { type: "object", "x-flowkit": { widget: "rules" } } }, ["rules"]),
    output: out({ matched: { type: "boolean" } }),
    branches: {
      kind: "static",
      branches: [
        { id: "if", label: "If" },
        { id: "else", label: "Else" },
      ],
    },
  },
  {
    type: "core.switch",
    plugin: "core",
    name: "Switch",
    icon: "git-fork",
    category: "Flow",
    description: "Pick a path by comparing a value against cases",
    summary: "Switch on {{value}}",
    input: obj(
      {
        value: str("Value"),
        cases: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, label: { type: "string" } },
          },
          default: [],
          "x-flowkit": { widget: "cases" },
        },
      },
      ["value", "cases"],
    ),
    output: out({ matched: { type: "string" } }),
    branches: {
      kind: "fromConfig",
      configPath: "cases",
      idKey: "id",
      labelKey: "label",
      append: [{ id: "default", label: "Default" }],
    },
  },
  {
    type: "core.forEach",
    plugin: "core",
    name: "For each",
    icon: "repeat",
    category: "Flow",
    description: "Run steps once for every item in a list",
    summary: "For each of {{items}}",
    input: obj(
      { items: { type: "array", items: {}, "x-flowkit": { refOnly: true, label: "Items" } } },
      ["items"],
    ),
    output: out({ items: { type: "array", items: {} } }),
    branches: { kind: "loop", itemsField: "items", branch: "body" },
  },
  {
    type: "core.stop",
    plugin: "core",
    name: "Stop",
    icon: "circle-stop",
    category: "Flow",
    description: "End the run here",
    summary: "Stop the run",
    input: obj({ reason: str("Reason") }),
    output: out({}),
    branches: { kind: "none" },
  },
  {
    type: "core.delay",
    plugin: "core",
    name: "Delay",
    icon: "hourglass",
    category: "Timing",
    description: "Pause for a while, or until a date",
    summary: "Wait {{duration}}",
    input: obj({ duration: str("Duration", { default: "1h" }), until: str("Until") }),
    output: out({ resumedAt: { type: "string" } }),
    branches: { kind: "none" },
  },
  {
    type: "core.waitForCallback",
    plugin: "core",
    name: "Wait for callback",
    icon: "bell",
    category: "Timing",
    description: "Pause until an outside system calls back",
    summary: "Wait up to {{timeout}}",
    input: obj({ timeout: str("Timeout", { default: "7d" }) }, ["timeout"]),
    output: out({ body: {}, timedOut: { type: "boolean" } }),
    branches: {
      kind: "static",
      branches: [
        { id: "resumed", label: "Resumed" },
        { id: "timeout", label: "Timed out" },
      ],
    },
  },
  {
    type: "core.httpRequest",
    plugin: "core",
    name: "HTTP request",
    icon: "globe",
    category: "Data",
    description: "Call any HTTP API",
    summary: "{{method}} {{url}}",
    input: obj(
      {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], default: "GET" },
        url: str("URL"),
      },
      ["method", "url"],
    ),
    output: out({ status: { type: "number" }, body: {} }),
    branches: { kind: "none" },
  },
  {
    type: "core.transform",
    plugin: "core",
    name: "Transform",
    icon: "code",
    category: "Data",
    description: "Reshape data with a little JavaScript",
    summary: "Run code",
    input: obj({ code: str("Code", { default: "return {};" }) }, ["code"]),
    output: out({}),
    branches: { kind: "none" },
  },
  {
    type: "core.callSubflow",
    plugin: "core",
    name: "Call workflow",
    icon: "workflow",
    category: "Data",
    description: "Run another workflow and use its output",
    summary: "Run {{workflowId}}",
    input: obj({ workflowId: str("Workflow") }, ["workflowId"]),
    output: out({}),
    branches: { kind: "none" },
  },
];

const crm: NodeManifest[] = [
  {
    type: "crm.loadContact",
    plugin: "crm",
    name: "Load contact",
    icon: "user",
    category: "Contacts",
    description: "Fetch a contact by ID",
    summary: "Load {{contactId}}",
    input: obj({ contactId: str("Contact") }, ["contactId"]),
    output: { kind: "schema", schema: { type: "object", properties: contact } },
    branches: { kind: "none" },
  },
  {
    type: "crm.updateContact",
    plugin: "crm",
    name: "Update contact",
    icon: "user-pen",
    category: "Contacts",
    description: "Change fields on a contact",
    summary: "Update {{contactId}}",
    input: obj({ contactId: str("Contact"), stage: str("Lifecycle stage") }, ["contactId"]),
    output: out({ id: { type: "string" } }),
    branches: { kind: "none" },
  },
  {
    type: "crm.addTag",
    plugin: "crm",
    name: "Add tag",
    icon: "tag",
    category: "Contacts",
    description: "Tag a contact",
    summary: "Tag {{tag}}",
    input: obj({ contactId: str("Contact"), tag: str("Tag") }, ["contactId", "tag"]),
    output: out({}),
    branches: { kind: "none" },
  },
  {
    type: "crm.sendEmail",
    plugin: "crm",
    name: "Send email",
    icon: "mail",
    category: "Messaging",
    description: "Email a contact from your team inbox",
    summary: "{{subject}}",
    input: obj({ to: str("To"), subject: str("Subject", { default: "Hello" }) }, ["to", "subject"]),
    output: out({ messageId: { type: "string" } }),
    branches: { kind: "none" },
  },
  {
    type: "crm.createTask",
    plugin: "crm",
    name: "Create task",
    icon: "list-checks",
    category: "Deals",
    description: "Assign a follow-up task to an owner",
    summary: "{{title}}",
    input: obj({ title: str("Title"), owner: str("Owner") }, ["title"]),
    output: out({ id: { type: "string" } }),
    branches: { kind: "none" },
  },
  {
    type: "crm.createDeal",
    plugin: "crm",
    name: "Create deal",
    icon: "handshake",
    category: "Deals",
    description: "Open a new deal in a pipeline",
    summary: "In {{pipeline}}",
    input: obj({ pipeline: str("Pipeline") }, ["pipeline"]),
    output: out({ id: { type: "string" } }),
    branches: { kind: "none" },
  },
];

const triggers: TriggerManifest[] = [
  {
    type: "crm.dealUpdated",
    plugin: "crm",
    name: "Deal updated",
    icon: "handshake",
    kind: "event",
    event: "deal.updated",
    config: obj({}),
    payload: out({
      dealId: { type: "string" },
      contactId: { type: "string" },
      stage: { type: "string" },
    }),
  },
  {
    type: "crm.contactCreated",
    plugin: "crm",
    name: "Contact created",
    icon: "user-plus",
    kind: "event",
    event: "contact.created",
    config: obj({}),
    payload: out({ contactId: { type: "string" } }),
  },
  {
    type: "core.manual",
    plugin: "core",
    name: "Manual",
    icon: "play",
    kind: "manual",
    config: obj({ fields: { type: "array", items: { type: "object" }, default: [] } }),
    payload: { kind: "fields", configPath: "fields" },
  },
];

/** Built-in nodes + the fake CRM plugin. */
export const manifest: Manifest = {
  plugins: [
    { id: "core", name: "Built-in" },
    { id: "crm", name: "Acme CRM", icon: "building-2" },
  ],
  nodes: [...core, ...crm],
  triggers,
};

const s = (
  id: string,
  type: string,
  config: Step["config"] = {},
  extra: Partial<Step> = {},
): Step => ({
  id,
  type,
  config,
  ...extra,
});

/** A deal-won workflow with nested branches, a loop, a leftover branch, a disabled and an invalid step. */
export function nestedDoc(): WorkflowDoc {
  return {
    id: "deal-won",
    name: "Deal won follow-up",
    trigger: { type: "crm.dealUpdated", config: {} },
    steps: [
      s("loadContact", "crm.loadContact", { contactId: { $ref: "trigger.contactId" } }),
      s(
        "isWon",
        "core.condition",
        { rules: { combinator: "and", rules: [] } },
        {
          name: "Deal won?",
          branches: {
            if: [
              s(
                "region",
                "core.switch",
                {
                  value: { $ref: "steps.loadContact.region" },
                  cases: [
                    { id: "emea", label: "EMEA" },
                    { id: "amer", label: "Americas" },
                  ],
                },
                {
                  name: "Region",
                  branches: {
                    emea: [
                      s("welcomeEmea", "crm.sendEmail", {
                        to: { $ref: "steps.loadContact.email" },
                        subject: { $tpl: "Welcome aboard, {{steps.loadContact.name}}" },
                      }),
                    ],
                    amer: [s("kickoffTask", "crm.createTask", { title: "Schedule kickoff call" })],
                    default: [],
                    apac: [s("apacTask", "crm.createTask", { title: "Hand over to APAC team" })],
                  },
                },
              ),
              s("markCustomer", "crm.updateContact", {
                contactId: { $ref: "trigger.contactId" },
                stage: "customer",
              }),
            ],
            else: [
              s("wait", "core.delay", { duration: "3d" }),
              s(
                "nudge",
                "crm.sendEmail",
                { to: { $ref: "steps.loadContact.email" } },
                { name: "Nudge email" },
              ),
            ],
          },
        },
      ),
      s(
        "eachTag",
        "core.forEach",
        { items: { $ref: "steps.loadContact.tags" } },
        {
          branches: {
            body: [
              s("addTag", "crm.addTag", {
                contactId: { $ref: "trigger.contactId" },
                tag: { $ref: "loop.item" },
              }),
            ],
          },
        },
      ),
      s(
        "notify",
        "core.httpRequest",
        { method: "POST", url: "https://hooks.example.com/deals" },
        { name: "Notify data team", disabled: true },
      ),
    ],
  };
}

/** A workflow with no steps yet. */
export function emptyDoc(): WorkflowDoc {
  return {
    id: "blank",
    name: "Untitled workflow",
    trigger: { type: "crm.contactCreated", config: {} },
    steps: [],
  };
}
