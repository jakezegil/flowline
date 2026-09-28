# Writing a plugin

A plugin is a group of node types and trigger types that share one ID prefix. The `crm` plugin,
for example, owns `crm.loadContact`, `crm.sendEmail` and `crm.contactCreated`. You pass plugins to
`createRegistry`. The registry turns them into a JSON manifest, and the editor renders its step
picker, config forms and data picker from that manifest.

```ts file=plugin.ts
import { createRegistry, definePlugin } from "@flowkit/core";
import { loadContact } from "./load-contact";
import { sendEmail } from "./send-email";
import { contactCreated } from "./triggers";

export const crm = definePlugin({
  id: "crm",
  name: "CRM",
  icon: "building",
  nodes: [loadContact, sendEmail],
  triggers: [contactCreated],
});

export const registry = createRegistry([crm]); // throws FlowkitDefinitionError on bad definitions
registry.manifest(); // what the browser gets
```

## Nodes

```ts file=load-contact.ts
import { defineNode, ui } from "@flowkit/core";
import { z } from "zod";

export const loadContact = defineNode({
  type: "crm.loadContact", // "<pluginId>.<name>", globally unique
  name: "Load contact",
  description: "Fetch a contact by ID.",
  icon: "user", // a bundled icon (bundledIconNames) or a <FlowkitProvider icons> key
  category: "Contacts", // the step picker tab
  summary: "Load {{contactId}}", // a template rendered against config, shown on the card
  input: z.object({ contactId: ui(z.string(), { label: "Contact" }) }),
  output: z.object({ id: z.string(), name: z.string(), email: z.string(), vip: z.boolean() }),
  run: ({ input, ctx }) => ctx.services.db.contacts.get(input.contactId),
});
```

- `input` is a Zod object. Before `run` is called, the engine resolves references in the config
  and validates the result against this schema. `input` in the handler is fully typed.
- `output` has two roles. At runtime it parses the value that the handler returns. At design time
  it describes what downstream steps can reference and type-check. Nodes without `output` produce
  untyped JSON. When the output shape depends on config, use
  `dynamicOutput: { kind: "fields", configPath }` together with a `fields()` input instead.
- `retry` overrides the default of `{ max: 3, backoff: "exponential", initialMs: 1000 }`.
  `timeoutMs` (default 300 000) aborts `ctx.signal` when it runs out.

### What the handler gets: `ctx`

| Member | Use it for |
|---|---|
| `ctx.services` | Your host services. Type them once with module augmentation (see [Services](#services)). |
| `ctx.idempotencyKey` | Pass it to every external side effect. It stays the same across retries of this step. |
| `ctx.signal` | It is aborted on timeout, on lease loss or on cancel. Pass it to `fetch` and to long work. |
| `ctx.secrets.get(name)` | Resolves a secret named by a `secret()` field. It throws `FatalError` if the secret is not configured. |
| `ctx.http.fetch(url, init)` | `fetch` with the SSRF guard. Credential headers are removed on cross-origin redirects. |
| `ctx.logger` | Logs attached to the run. |
| `ctx.callback({ timeoutMs })` / `ctx.resume` | Suspend and resume (see [Suspending](#suspending)). |
| `ctx.scope` | Read-only `trigger`, `steps` and `loop` values. Prefer declared inputs. |
| `ctx.now()` | The engine clock. Use it instead of `Date.now()`, so that tests can control time. |

### Side effects and errors

Steps run **at least once**. A worker can crash, or a step can time out, after an external call
has already succeeded. The step then runs again, and in some cases the first attempt is still
running. So key every side effect on `ctx.idempotencyKey`:

```ts file=send-email.ts
import { defineNode, sensitive, ui } from "@flowkit/core";
import { z } from "zod";

export const sendEmail = defineNode({
  type: "crm.sendEmail",
  name: "Send email",
  icon: "mail",
  category: "Email",
  summary: "Email {{to}}",
  input: z.object({
    to: ui(z.email(), { label: "To" }),
    subject: z.string().describe("Shown as help text under the field."),
    body: sensitive(ui(z.string(), { multiline: true })).optional(),
  }),
  output: z.object({ messageId: z.string() }),
  retry: { max: 5, backoff: "exponential", initialMs: 2000 },
  timeoutMs: 30_000,
  run: ({ input, ctx }) =>
    ctx.services.mailer.send(input, { idempotencyKey: ctx.idempotencyKey, signal: ctx.signal }),
});
```

- `throw new FatalError(message)` fails the step at once, with no retries. Use it for bad input,
  missing records and 4xx responses.
- `throw new RetryableError(message)`, or any other error, is retried according to `retry`.
- Both classes come from `@flowkit/core`, and `@flowkit/engine` re-exports them.

To call an HTTP API with a credential, use a `secret()` field together with `ctx.http`:

```ts file=enrich.ts
import { defineNode, FatalError, RetryableError, secret } from "@flowkit/core";
import { z } from "zod";

export const enrichCompany = defineNode({
  type: "crm.enrichCompany",
  name: "Enrich company",
  input: z.object({ domain: z.string(), apiKey: secret().describe("Enrichment API key") }),
  output: z.object({ employees: z.number() }),
  run: async ({ input, ctx }) => {
    const res = await ctx.http.fetch(`https://api.enrich.example/v1/${input.domain}`, {
      headers: { authorization: `Bearer ${await ctx.secrets.get(input.apiKey)}` },
      timeoutMs: 10_000,
    });
    if (res.status === 404) throw new FatalError(`Unknown domain ${input.domain}`);
    if (!res.ok) throw new RetryableError(`Enrichment API: HTTP ${res.status}`);
    return (await res.json()) as { employees: number };
  },
});
```

The workflow doc stores only the secret's name (for example `"ENRICH_KEY"`). The value comes from
`createEngine({ secrets })` at runtime, and it never reaches docs, journals or events.

### Branching nodes

Declare the branches, then return `branch(id, output)`:

```ts file=deal-size.ts
import { branch, defineNode } from "@flowkit/core";
import { z } from "zod";

export const dealSize = defineNode({
  type: "crm.dealSize",
  name: "Deal size",
  input: z.object({ amount: z.number() }),
  output: z.object({ amount: z.number() }),
  branches: {
    kind: "static",
    branches: [
      { id: "small", label: "Small" },
      { id: "large", label: "Large" },
    ],
  },
  run: ({ input }) => branch(input.amount >= 10_000 ? "large" : "small", input),
});
```

For branches that come from config, such as switch cases, use
`{ kind: "fromConfig", configPath, idKey, labelKey, append }`. For a loop over config
`itemsField`, use `{ kind: "loop", itemsField, branch: "body" }` and return `loop(items)`. A
handler can also return `stop(reason)` to end the run successfully, or
`invokeSubflow({ workflowId, input })` to call another workflow.

### Suspending

Return `suspend({ until })` to wait until a time, or `suspend({ callback })` to wait for an HTTP
call. When the run resumes, the handler is called again with `ctx.resume` set. Announce the resume
URL from `afterCommit`. It runs only after the suspension is committed, so the URL already works
when it is sent.

```ts file=approval.ts
import { defineNode, suspend } from "@flowkit/core";
import { z } from "zod";

export const requestApproval = defineNode({
  type: "crm.requestApproval",
  name: "Request approval",
  input: z.object({ approver: z.string() }),
  output: z.object({ approved: z.boolean() }),
  run: async ({ input, ctx }) => {
    if (ctx.resume?.kind === "callback") return { approved: ctx.resume.body === "yes" };
    if (ctx.resume?.kind === "timeout") return { approved: false };
    const cb = await ctx.callback({ timeoutMs: 3 * 24 * 3600_000 });
    return suspend({
      callback: cb,
      afterCommit: ({ signal }) =>
        ctx.services.db.approvals.create(
          { approver: input.approver, resumeUrl: cb.resumeUrl, key: ctx.idempotencyKey },
          { signal },
        ),
    });
  },
});
```

`afterCommit` is best effort. It runs at most once across crashes. If it throws `RetryableError`
or times out, it is retried, up to 3 tries. If it finally fails, the engine records
`step.afterCommitFailed` and the run keeps waiting. The resume URL never enters the journal, so
`afterCommit` is the only place where you can hand it out.

Declare how the wait is resumed with `resume` on the node. `resume.body` is a Zod schema that
the engine checks every callback body against (400 on a mismatch, nothing resumed).
`resume.hostHandled: true` says your app resumes it, for example from an approvals page that
checks who may decide by calling `engine.resumeRun`. The generic `POST /runs/:id/resume` route
then answers 409 and the run viewer shows `resume.hint` instead of its Resume form. The token
is still a bearer capability: `POST /resume/:token` resumes a host-handled wait too. So for such
a step, never hand out `cb.token` or `cb.resumeUrl`; resume it by run ID instead.

## Triggers

```ts file=triggers.ts
import { defineTrigger, ui } from "@flowkit/core";
import { z } from "zod";

export const contactCreated = defineTrigger({
  type: "crm.contactCreated",
  name: "Contact created",
  icon: "user-plus",
  kind: "event", // "event" | "webhook" | "manual" | "schedule" | "subflow"
  event: "contact.created",
  config: z.object({
    source: ui(z.string(), { label: "Only from source", placeholder: "web" }).optional(),
  }),
  payload: z.object({ contactId: z.string(), source: z.string() }), // becomes `trigger.*` in refs
  filter: ({ config, payload }) => !config.source || payload.source === config.source,
  dedupeKey: ({ payload }) => payload.contactId,
});
```

Your app fires the trigger with
`engine.emit("contact.created", payload, { tenantId })`. The payload is validated against
`payload`. A dedupe key is scoped to one workflow, and dedupe is effectively permanent: repeating a
key starts no new run.

## UI metadata

The editor builds the config form from the input's JSON Schema. You can refine it with these
helpers:

- `ui(schema, meta)` attaches editor hints. They travel in the manifest under `x-flowkit`. Wrap the
  inner schema and chain modifiers afterwards: `ui(z.string(), { label: "Email" }).optional()`.
- `.describe(text)` becomes help text under the field.
- `secret()` is a string field that holds a secret's name. The editor picks it from
  `GET /secrets`. It is literal-only: a reference (into it, or into an object that holds one) is
  a validation error, and the engine refuses one at runtime too, so trigger data can never choose
  which secret is sent. A name that `secrets.list` doesn't return is a warning.
- `sensitive(schema)` masks the value in events and in the run viewer.
- `fields()` is a list of `{ name, type, required? }` declarations. Pair it with
  `dynamicOutput: { kind: "fields", configPath }`.

| `UiMeta` key | Effect |
|---|---|
| `label`, `placeholder`, `group` | The field label (by default a humanized key), the placeholder, and a collapsible section the field goes in (`"Advanced"` starts collapsed). |
| `widget` | Chooses a control: a built-in one or one you register. |
| `multiline` | Makes a text input multi-line. |
| `hidden` | Leaves the field out of the form. |
| `refOnly` / `literalOnly` | Accepts only a reference, or only a literal. |
| `oneOfRequired` | Goes on the object schema. Exactly one group of properties must be set, for example `[["duration"], ["until"]]`. |
| `warnIfEmpty` | Goes on an array. The validator warns with this message if the list is empty. |

Without a `widget`, a field gets a default control for its schema type. Strings get a text input
that also accepts references (pills). Numbers and booleans get their own inputs, with a toggle to
switch to a reference. Enums get a select. Arrays of objects get repeatable groups, and objects get
fieldsets.

These widgets are built in:

- `rules`
- `cases`
- `fields`
- `code`
- `secret`
- `subflowSelect`
- `subflowInput`

## Custom widgets

A widget is a React component that receives `FieldWidgetProps`. Give it a namespaced ID in the
schema, then register it on the provider:

```ts file=assign-owner.ts
// assign-owner.ts: the node names the widget (server and shared code)
import { defineNode, ui } from "@flowkit/core";
import { z } from "zod";

export const assignOwner = defineNode({
  type: "crm.assignOwner",
  name: "Assign owner",
  input: z.object({ ownerId: ui(z.string(), { label: "Owner", widget: "crm.userSelect" }) }),
  output: z.object({ ownerId: z.string() }),
  run: ({ input }) => ({ ownerId: input.ownerId }),
});
```

```tsx file=user-select.tsx
// user-select.tsx: in the browser
import { createClient } from "@flowkit/core/client";
import { type FieldWidgetProps, FlowkitProvider, WorkflowEditor } from "@flowkit/react";
import { useUsers } from "./api";

export function UserSelect({ value, onChange, meta, readOnly }: FieldWidgetProps) {
  const users = useUsers();
  return (
    <select
      aria-label={meta.label ?? "User"}
      disabled={readOnly}
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value || undefined)}
    >
      <option value="">Choose a user</option>
      {users.map((u) => (
        <option key={u.id} value={u.id}>
          {u.name}
        </option>
      ))}
    </select>
  );
}

const widgets = { "crm.userSelect": UserSelect }; // module scope keeps it stable
const client = createClient({ baseUrl: "/flowkit" });

export function Editor() {
  return (
    <FlowkitProvider client={client} widgets={widgets}>
      <WorkflowEditor workflowId="assign-deals" />
    </FlowkitProvider>
  );
}
```

- `value` is any `ValueExpr`: a literal, a `{ $ref }` or a `{ $tpl }`. If your widget handles only
  literals, render something sensible for the other two.
- `onChange(undefined)` removes the key from config.
- `schema` and `meta` give you the field's JSON Schema and its `x-flowkit` hints. `stepId` and
  `fieldKey` tell you where the widget sits.
- Keep the `widgets` object stable, for example at module scope or in `useMemo`.
- Widgets live only in the browser bundle. The manifest carries only the widget ID, so server code
  never imports React.

## Services

Tell TypeScript what `ctx.services` holds, once, anywhere in your server code:

```ts file=services-types.ts
import type { Db, Mailer } from "./services";

declare module "@flowkit/core" {
  interface FlowkitServices {
    db: Db;
    mailer: Mailer;
  }
}
```

With this in place, TypeScript checks every handler's `ctx.services`, and it checks the `services`
you pass to `createEngine({ services: { db, mailer } })`. The `services` option itself stays
optional, though, so TypeScript does not catch a call that leaves it out entirely.

## Testing

`@flowkit/engine/testing` has two helpers:

- `testNode(node, input, ctx?)` parses `input`, runs the handler with a default context (which your
  `ctx` overrides), and parses the output. It returns signals such as `branch()` or `suspend()` as
  they are. The result is typed as the node's output (or a signal), so no casts are needed.
- `runWorkflowInMemory(doc, { plugins, services, trigger })` runs a whole workflow on a fresh
  in-memory engine. It moves the clock forward through delays and retries, so a `2d` delay finishes
  at once. It needs `@flowkit/storage-memory` as a dev dependency. It also takes:
  - `secrets: { name: "value" }`, the values `ctx.secrets.get(name)` returns. A name that isn't
    listed is "not configured", as in production.
  - `http`, the network policy of `ctx.http.fetch`. The default blocks private addresses, so set
    `http: { allowPrivateNetworks: true }` to reach a mock server on `localhost`.
  - `subflows: [doc, …]`, sub-flows the workflow calls. They are published first and run along
    with it.

```ts file=plugin.test.ts
import { ref, workflow } from "@flowkit/core";
import { runWorkflowInMemory, testNode } from "@flowkit/engine/testing";
import { manualTrigger } from "@flowkit/nodes-builtin";
import { describe, expect, it } from "vitest";
import { dealSize } from "./deal-size";
import { loadContact } from "./load-contact";
import { crm } from "./plugin";
import { fakeServices } from "./test-utils"; // returns a complete FlowkitServices

const ada = { id: "c1", name: "Ada", email: "ada@example.com", vip: true };

describe("crm plugin", () => {
  it("loads a contact", async () => {
    const services = fakeServices({ contacts: [ada] });
    expect(await testNode(loadContact, { contactId: "c1" }, { services })).toEqual(ada);
  });

  it("routes large deals", async () => {
    expect(await testNode(dealSize, { amount: 50_000 })).toMatchObject({ branch: "large" });
  });

  it("runs end to end", async () => {
    const doc = workflow("load")
      .trigger(manualTrigger, { fields: [{ name: "id", type: "string", required: true }] })
      .step("contact", loadContact, { contactId: ref("trigger.id") })
      .build();

    const { run, events } = await runWorkflowInMemory(doc, {
      plugins: [crm],
      services: fakeServices({ contacts: [ada] }),
      trigger: { id: "c1" },
    });

    expect(run.status).toBe("completed");
    expect(run.journal.contact).toMatchObject({ status: "done", output: ada });
    expect(events.at(-1)?.type).toBe("run.completed");
  });
});
```

`services` is typed as your whole `FlowkitServices`, so a small factory that builds fakes for all of
them keeps tests short. `testNode` on a handler that uses no services needs no `ctx` at all.

## Checklist

- The `type` is `<pluginId>.<name>`, and nothing ever renames it: saved workflows refer to it.
- Declare `output`, so that references are typed and validated.
- Every side effect uses `ctx.idempotencyKey` and `ctx.signal`.
- Use `FatalError` for failures that retrying cannot fix.
- Credentials go in `secret()` fields and PII in `sensitive()` fields, never in plain config.
- Write a `summary` template, so that cards on the canvas say what the step does.
- Write a `testNode` test for each handler, and a `runWorkflowInMemory` test for each real
  workflow.
