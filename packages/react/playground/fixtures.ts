/**
 * Playground fixtures: the real built-in manifest (plugin "core", dumped from
 * `@flowlinejs/nodes-builtin` into builtin-manifest.json) plus a fake CRM plugin, and sample
 * workflows. The editor only ever sees JSON, so no server code is needed.
 */
import type { Manifest, NodeManifest, Step, TriggerManifest, WorkflowDoc } from "@flowlinejs/core";
import builtin from "./builtin-manifest.json";

const S = "https://json-schema.org/draft/2020-12/schema";
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  $schema: S,
  type: "object",
  properties,
  required,
});
const str = (label: string, extra: Record<string, unknown> = {}) => ({
  type: "string",
  "x-flowline": { label },
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
    input: obj(
      {
        contactId: str("Contact"),
        stage: {
          type: "string",
          enum: ["lead", "qualified", "customer", "churned"],
          "x-flowline": { label: "Lifecycle stage" },
        },
        owner: str("Owner", { description: "Email of the new account owner." }),
      },
      ["contactId"],
    ),
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
    input: obj(
      {
        to: str("To", { format: "email" }),
        subject: str("Subject"),
        body: {
          type: "string",
          "x-flowline": { label: "Message", multiline: true, placeholder: "Hi {{name}}, …" },
        },
        from: {
          type: "string",
          enum: ["sales", "success", "support"],
          default: "sales",
          "x-flowline": { label: "Send from" },
        },
        trackOpens: {
          type: "boolean",
          default: true,
          "x-flowline": { label: "Track opens", group: "Advanced" },
        },
      },
      ["to", "subject"],
    ),
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
    input: obj(
      {
        title: str("Title"),
        owner: str("Owner"),
        dueInDays: { type: "integer", minimum: 0, "x-flowline": { label: "Due in (days)" } },
        priority: {
          type: "string",
          enum: ["low", "normal", "high"],
          default: "normal",
          "x-flowline": { label: "Priority" },
        },
      },
      ["title"],
    ),
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
  ...(builtin.triggers as TriggerManifest[]),
];

/** Built-in nodes + the fake CRM plugin. */
export const manifest: Manifest = {
  plugins: [...builtin.plugins, { id: "crm", name: "Acme CRM", icon: "building-2" }],
  nodes: [...(builtin.nodes as NodeManifest[]), ...crm],
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
        {
          rules: {
            combinator: "and",
            rules: [
              { left: { $ref: "trigger.stage" }, op: "eq", right: "won" },
              {
                combinator: "or",
                rules: [
                  { left: { $ref: "steps.loadContact.region" }, op: "eq", right: "EMEA" },
                  { left: { $ref: "steps.loadContact.tags" }, op: "contains", right: "vip" },
                ],
              },
            ],
          },
        },
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
                    { id: "emea", label: "EMEA", value: "EMEA" },
                    { id: "amer", label: "Americas", value: "AMER" },
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
        {
          method: "POST",
          url: "https://hooks.example.com/deals",
          headers: { "X-Source": "flowline" },
          bodyType: "json",
          body: { dealId: { $ref: "trigger.dealId" }, stage: { $ref: "trigger.stage" } },
          auth: { type: "bearer", secret: "DATA_TEAM_TOKEN" },
        },
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

/** An inbound-lead workflow started by a webhook. */
export function webhookDoc(): WorkflowDoc {
  return {
    id: "inbound-lead",
    name: "Inbound lead",
    trigger: {
      type: "core.webhook",
      config: {
        slug: "k3v9q2hx7m",
        fields: [
          { name: "email", type: "string", required: true, description: "Lead's work email" },
          { name: "company", type: "string" },
          { name: "seats", type: "number" },
        ],
        dedupeHeader: "X-Request-Id",
      },
    },
    steps: [
      s(
        "route",
        "core.switch",
        {
          value: { $ref: "trigger.seats" },
          cases: [
            { id: "enterprise", label: "Enterprise", value: "100" },
            { id: "team", label: "Team", value: "10" },
          ],
        },
        {
          name: "Route by size",
          branches: {
            enterprise: [
              s("aeTask", "crm.createTask", {
                title: { $tpl: "Call {{trigger.company}}" },
                priority: "high",
              }),
            ],
            team: [],
            default: [],
          },
        },
      ),
      s("summarize", "core.transform", {
        code: "return { domain: trigger.email.split('@')[1] };",
        outputFields: [{ name: "domain", type: "string" }],
      }),
      s("enrich", "core.callSubflow", { workflowId: "enrich-company", input: {} }),
    ],
  };
}

/**
 * A lead-routing workflow dressed with annotations: adjacent top-level sections, sections
 * nested in both branches of a condition (one with a note), sticky notes on steps in the root
 * column, a branch and a loop body, and coloured cards.
 */
export function annotatedDoc(): WorkflowDoc {
  return {
    id: "lead-routing",
    name: "Lead routing",
    trigger: { type: "crm.contactCreated", config: {} },
    steps: [
      s(
        "loadContact",
        "crm.loadContact",
        { contactId: { $ref: "trigger.contactId" } },
        { note: "Pulls the full record, tags included — later steps read region and tags." },
      ),
      s(
        "enrich",
        "core.httpRequest",
        {
          method: "GET",
          url: "https://api.enrich.example/v2/people",
          query: { email: { $ref: "steps.loadContact.email" } },
        },
        { name: "Enrich profile" },
      ),
      s(
        "score",
        "core.transform",
        {
          code: "return { score: trigger.contactId ? 82 : 0 };",
          outputFields: [{ name: "score", type: "number" }],
        },
        { name: "Score lead", color: "blue" },
      ),
      s(
        "isHot",
        "core.condition",
        {
          rules: {
            combinator: "and",
            rules: [{ left: { $ref: "steps.score.score" }, op: "gte", right: 70 }],
          },
        },
        {
          name: "Hot lead?",
          branches: {
            if: [
              s("createDeal", "crm.createDeal", { pipeline: "New business" }, { color: "pink" }),
              s(
                "introCall",
                "crm.createTask",
                { title: "Book an intro call", priority: "high", dueInDays: 0 },
                { note: "SLA: an AE reaches out within two business hours." },
              ),
            ],
            else: [
              s("cooldown", "core.delay", { duration: "2d" }, { name: "Cool-down" }),
              s(
                "eachTag",
                "core.forEach",
                { items: { $ref: "steps.loadContact.tags" } },
                {
                  name: "For each interest",
                  branches: {
                    body: [
                      s(
                        "nurture",
                        "crm.sendEmail",
                        {
                          to: { $ref: "steps.loadContact.email" },
                          subject: { $tpl: "Ideas for {{loop.item}}" },
                        },
                        {
                          name: "Nurture email",
                          color: "green",
                          note: "One email per interest tag, from the success inbox.",
                        },
                      ),
                    ],
                  },
                },
              ),
            ],
          },
        },
      ),
      s(
        "markLead",
        "crm.updateContact",
        { contactId: { $ref: "trigger.contactId" }, stage: "qualified" },
        { name: "Mark qualified", color: "purple" },
      ),
      s(
        "notify",
        "core.httpRequest",
        { method: "POST", url: "https://hooks.example.com/leads", bodyType: "json" },
        {
          name: "Notify sales channel",
          note: "Posts to #sales-leads. Swap the URL per region before launch.",
        },
      ),
    ],
    sections: [
      {
        id: "research",
        title: "Research the lead",
        color: "blue",
        first: "loadContact",
        last: "score",
      },
      {
        id: "route",
        title: "Route by score",
        color: "purple",
        note: "Scores of 70+ go straight to sales; everyone else is nurtured.",
        first: "isHot",
        last: "isHot",
      },
      {
        id: "fastTrack",
        title: "Fast track",
        color: "pink",
        first: "createDeal",
        last: "introCall",
      },
      {
        id: "nurtureTrack",
        title: "Nurture",
        color: "green",
        note: "Gentle drip over two weeks.",
        first: "cooldown",
        last: "eachTag",
      },
      { id: "wrapUp", title: "Hand-off", color: "yellow", first: "markLead", last: "notify" },
    ],
  };
}
