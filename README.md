# Flowkit

An embeddable workflow builder for TypeScript apps, in the style of Zapier or n8n. You define typed
nodes in code. Your users arrange them into workflows on a canvas. A durable engine runs those
workflows over your own database and records an audit trail.

- **Typed nodes in about ten lines.** Zod schemas give you types in the handler, the editor's
  config form and the data picker.
- **A tree model.** Workflows are made of sequential steps and branch blocks that rejoin. There is
  no free-form wiring, so non-developers can read them.
- **References and templates.** `{ $ref: "steps.lookup.email" }` and `"Hi {{trigger.name}}"`
  are type-checked against upstream output schemas, in the editor and on publish.
- **Durable execution.** Runs survive crashes, sleep for days, and wait for webhooks or approvals.
  Every step is journaled.
- **Built-in nodes and triggers.** Condition, switch, forEach, stop, delay, wait for callback,
  HTTP request (with an SSRF guard), a JavaScript transform (in a QuickJS sandbox) and
  sub-flows. Triggers cover app events, webhooks, manual starts, cron schedules and sub-flow calls.
- **Storage you choose.** Adapters for memory and Postgres are included, and a conformance suite
  checks your own.
- **A React editor and run viewer.** You can theme them with CSS tokens and replace their
  labels, icons and field widgets.

## Quick start

The quick start sets up the following:

- a node and a trigger
- an engine on Postgres
- the HTTP API
- a worker
- one published workflow
- the editor

At the end, one app event produces a completed run. `examples/docs-check` runs exactly these
snippets on every `pnpm test`.

```sh
pnpm add @flowkit/core @flowkit/nodes-builtin @flowkit/engine @flowkit/storage-postgres @flowkit/react zod pg
pnpm add hono @hono/node-server # or any other fetch-style server
```

### 1. Define a node

```ts file=flowkit/nodes.ts
// flowkit/nodes.ts
import { defineNode, ui } from "@flowkit/core";
import { z } from "zod";
import type { Db } from "../db";

// Type ctx.services once, for every handler.
declare module "@flowkit/core" {
  interface FlowkitServices {
    db: Db;
  }
}

export const loadContact = defineNode({
  type: "crm.loadContact",
  name: "Load contact",
  icon: "user",
  summary: "Load {{contactId}}",
  input: z.object({ contactId: ui(z.string(), { label: "Contact" }) }),
  output: z.object({ id: z.string(), name: z.string(), email: z.string(), vip: z.boolean() }),
  run: ({ input, ctx }) => ctx.services.db.contacts.get(input.contactId),
});
```

### 2. Group nodes into a plugin

```ts file=flowkit/plugin.ts
// flowkit/plugin.ts
import { createRegistry, definePlugin, defineTrigger } from "@flowkit/core";
import { z } from "zod";
import { loadContact } from "./nodes";

export const contactCreated = defineTrigger({
  type: "crm.contactCreated",
  name: "Contact created",
  kind: "event",
  event: "contact.created",
  config: z.object({}),
  payload: z.object({ contactId: z.string() }),
});

export const crm = definePlugin({
  id: "crm",
  name: "CRM",
  nodes: [loadContact],
  triggers: [contactCreated],
});
export const registry = createRegistry([crm]);
```

### 3. Create the engine

```ts file=flowkit/engine.ts
// flowkit/engine.ts
import { createEngine } from "@flowkit/engine";
import { createPostgresStorage, migrate } from "@flowkit/storage-postgres";
import pg from "pg";
import { getSession } from "../auth";
import { db } from "../db";
import { vault } from "../vault";
import { registry } from "./plugin";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await migrate(pool); // idempotent and safe to run concurrently

export const engine = createEngine({
  registry, // the built-in core.* nodes and triggers are added for you
  storage: createPostgresStorage({ pool }),
  services: { db },
  secrets: { get: (tenantId, name) => vault.get(tenantId, name) },
  authorize: async (req) => {
    const session = await getSession(req);
    return session ? { tenantId: session.orgId, userId: session.userId } : null;
  },
  publicUrl: "https://app.example.com", // used to build webhook and resume URLs
});
```

For tests and prototypes, use `createMemoryStorage()` from `@flowkit/storage-memory` instead.

### 4. Mount the HTTP handler

`engine.handler` is a `(Request) => Promise<Response>` function, so it works with any server that
speaks `fetch`. It serves every route under `basePath`. The default is `/flowkit`, and you can
change it with `createEngine({ basePath })`. Mount the handler at the same path. This example uses
Hono:

```ts file=server.ts
// server.ts
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { engine } from "./flowkit/engine";

const app = new Hono();
app.all("/flowkit/*", (c) => engine.handler(c.req.raw));
serve({ fetch: app.fetch, port: 3000 });
```

### 5. Start a worker

```ts file=worker.ts
// worker.ts (or at the end of server.ts)
import { engine } from "./flowkit/engine";

export const worker = engine.startWorker({ concurrency: 4 });
process.on("SIGTERM", () => void worker.stop()); // waits for in-flight steps
```

The worker can share a process with the API or run on its own. Every worker polls the same
storage, so you can run as many as you need.

### 6. Publish a workflow

Triggers only start *published* workflows. You can build and publish a workflow in the editor
(step 7), or in code:

```ts file=flowkit/workflows.ts
// flowkit/workflows.ts
import { ref, workflow } from "@flowkit/core";
import { engine } from "./engine";
import { loadContact } from "./nodes";
import { contactCreated } from "./plugin";

export const welcomeContact = workflow("welcome-contact", { name: "Welcome new contacts" })
  .trigger(contactCreated, {})
  .step("contact", loadContact, { contactId: ref("trigger.contactId") })
  .build();

/** Save a new version and publish it. Throws FlowkitValidationError if the doc is invalid. */
export async function publishWorkflows(tenantId: string) {
  const { version } = await engine.saveWorkflow(tenantId, welcomeContact, "setup");
  await engine.publish(tenantId, welcomeContact.id, version, "setup");
}
```

### 7. Embed the editor

```tsx file=WorkflowPage.tsx
// WorkflowPage.tsx
import { createClient } from "@flowkit/core/client";
import { FlowkitProvider, WorkflowEditor } from "@flowkit/react";
import "@flowkit/react/styles.css";

const client = createClient({ baseUrl: "/flowkit" });

export function WorkflowPage() {
  return (
    <FlowkitProvider client={client}>
      <div style={{ height: "100vh" }}>
        <WorkflowEditor workflowId="welcome-contact" />
      </div>
    </FlowkitProvider>
  );
}
```

This page opens the workflow from step 6. Users can edit it and publish new versions from the
editor's header. For a `workflowId` that does not exist yet, the editor opens a blank workflow
with a manual trigger.

The browser receives only the JSON manifest. `@flowkit/core` and `@flowkit/react` never import
the engine or any server-only code.

### 8. Start runs from your app

```ts file=app.ts
// app.ts, e.g. wherever your app creates contacts
import { engine } from "./flowkit/engine";
import { publishWorkflows } from "./flowkit/workflows";

await publishWorkflows("acme"); // once, at deploy or startup. Each call saves a new version.
await engine.emit("contact.created", { contactId: "c_42" }, { tenantId: "acme" });
```

`emit` starts every published workflow whose trigger listens for the event. It validates the
payload and returns the new run IDs. The worker then runs the steps. To see the completed run, use
`GET /flowkit/runs` or `<RunList>` and `<RunViewer>`. For a workflow with a manual trigger, call
`engine.start({ tenantId, workflowId, input })`. It validates `input` against the trigger's
declared fields.

To see all of this without a UI or a database, run the headless example with
`pnpm --filter headless start`.

## Concepts

### Tree model

A `WorkflowDoc` is plain JSON with a single trigger and a list of steps. Branching nodes such as
`core.condition`, `core.switch` and `core.forEach` hold nested step lists, keyed by branch ID
(`if`/`else`, the switch case IDs plus `default`, or `body`). When a branch block ends, its
branches rejoin and execution continues with the next step. You can build a doc in the editor or
in code:

```ts file=flowkit/welcome-vip.ts
import { ref, tpl, workflow } from "@flowkit/core";
import { and, conditionNode, isTrue, manualTrigger, stopNode } from "@flowkit/nodes-builtin";
import { sendEmail } from "./email"; // defined in the plugin guide
import { engine } from "./engine";
import { loadContact } from "./nodes";

const doc = workflow("welcome-vip", { name: "Welcome VIPs" })
  .trigger(manualTrigger, { fields: [{ name: "contactId", type: "string", required: true }] })
  .step("contact", loadContact, { contactId: ref("trigger.contactId") })
  .step(
    "check",
    conditionNode,
    { rules: and(isTrue(ref("steps.contact.vip"))) },
    {
      if: (b) =>
        b.step("email", sendEmail, {
          to: ref("steps.contact.email"),
          subject: tpl("Hi {{steps.contact.name}}"),
        }),
      else: (b) => b.step("halt", stopNode, { reason: "Not a VIP" }),
    },
  )
  .build();

const { version } = await engine.saveWorkflow("acme", doc, "user_1");
await engine.publish("acme", doc.id, version, "user_1"); // throws FlowkitValidationError if invalid
```

Text comparisons in rules (`core.condition`) and in `core.switch` are case-insensitive by default,
so `"VIP"` equals `"vip"`. They are also loose: `"5"` equals `5`. To match case, set
`caseSensitive: true` on a rule, or on the whole switch in its config. The rule helpers take it as
an option too: `eq(ref("trigger.tier"), "VIP", { caseSensitive: true })`.

Every save creates an immutable, numbered version. Triggers start only the published version, and
each run stays pinned to the version it started on.

### References and templates

A config value can be a literal, a `{ $ref: path }`, a `{ $tpl: "...{{path}}..." }`, or an array
or object containing any of these. The `ref()` and `tpl()` helpers build them and check their
syntax. A path can start with any of these roots:

- `trigger.<path>`
- `steps.<stepId>.<path>`
- `loop.item.<path>`
- `loop.index`
- `run.id`

A step can see the trigger, the earlier steps in its own list, and the earlier steps around each
block that encloses it. Steps inside a branch are not visible after the block rejoins, but the
block's own output is. The validator checks that every reference resolves, and that the
referenced type fits the field. It runs live in the editor and again on publish. A template always
produces a string.

### Durability contract

- **A step runs at least once.** A step that has been committed never runs again. But if a worker
  crashes or times out during a step, that step runs again, possibly while the first attempt is
  still going. Pass `ctx.idempotencyKey` to any external system that has side effects. It stays the
  same across every retry of the step.
- A handler gets `ctx.signal`. It is aborted when the step times out, the worker loses its lease,
  or the run is cancelled. Pass it to `fetch`.
- Retries follow the node's `retry` policy (by default 3 attempts, with exponential backoff
  starting at 1 s). Throw `FatalError` to fail at once. Throw `RetryableError`, or any other error,
  to retry. Both classes are exported from `@flowkit/core` and from `@flowkit/engine`. If the input
  or output fails schema validation, the step fails at once.
- `engine.retryRun` continues a failed run from its failed step. `engine.cancelRun` cancels a run
  that is queued or waiting at once. If a worker is running the run, it cancels at the next
  checkpoint.

### Suspend and resume

A handler can return `suspend({ until })` to wait until a time, or `suspend({ callback })` to wait
for an HTTP call. When the run resumes, the engine calls the same handler again, with
`ctx.resume` set to one of `timer`, `callback`, `timeout`, `subflow` or `subflowFailed`.

```ts file=flowkit/approval.ts
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
      // Runs only after the suspension is committed, so the URL already works when it is sent.
      afterCommit: ({ signal }) =>
        ctx.services.db.approvals.create(
          { approver: input.approver, resumeUrl: cb.resumeUrl, key: ctx.idempotencyKey },
          { signal },
        ),
    });
  },
});
```

- Use `afterCommit` to announce a resume URL, for example by emailing it or by creating an
  approval record. It is ephemeral and best effort. It runs at most once, even if the worker
  crashes, and it is retried a bounded number of times: 3 tries when it throws `RetryableError`
  or times out. If it finally fails, the engine records a `step.afterCommitFailed` event and the
  run keeps waiting.
- Callback tokens and resume URLs are never journaled, never put into events, and never returned
  by the API. `POST <basePath>/resume/:token` is the public resume route: the token is the
  credential. The authorized `POST <basePath>/runs/:id/resume` route (`engine.resumeRun`) is the
  ops path, used by the run viewer.
- `core.waitForCallback` has an optional `notify: { url }`. Once the wait is committed, the engine
  POSTs `{ resumeUrl, expiresAt, runId }` to that URL, with redirects refused.

### Triggers

- **Events.** `engine.emit(event, payload, { tenantId, dedupeKey? })` starts a run for each
  matching trigger. It validates the payload first. A trigger can also define `filter` and
  `dedupeKey`.
- **Webhooks.** `POST <basePath>/hooks/:tenantId/:workflowId/:slug` starts a run. The engine
  generates the slug on the first save. You can add an HMAC check with
  `X-Flowkit-Signature: sha256=<hex>`. The engine never stores the `authorization`, `cookie`,
  signature or `proxy-*` headers.
- **Schedules.** Cron expressions with a time zone. Schedules do not catch up after downtime: only
  the most recent missed fire runs.
- **Deduplication.** Dedupe keys are scoped to a workflow, and they are effectively permanent,
  because the run ID is derived from the key. If you reuse a key, even much later, you get the
  original run ID back.

### Sub-flows

A workflow with a `core.subflow` trigger declares input and output fields. `core.callSubflow` then
calls it as a step. The child run is created, and the parent is woken, inside the same atomic
storage commit. The child's output is checked against the declared output fields. Nesting can go 8
levels deep. A workflow that calls itself directly is a validation error.

### Audit trail

Every run keeps an append-only list of `RunEvent`s: `run.started`, `step.started`,
`step.completed`, `step.retrying`, `run.suspended`, `run.completed` and more. Each event has a
`seq` field that increases strictly within the run. Saves and publishes are recorded as
`WorkflowAuditEntry`s. To read a run, use `engine.getRunDetail(tenantId, runId)`. To follow a
live run, use `GET <basePath>/runs/:id/stream` (SSE) or `engine.subscribe(runId, fn)`.

Fields marked `secret()` hold the name of a secret, never its value. Fields marked `sensitive()`
may hold PII. Each place that stores or shows values masks them differently:

| Where | `secret` fields | `sensitive` fields |
|---|---|---|
| Journal (read by downstream steps) | masked | kept |
| Events (`step.completed` data, SSE) | masked | masked |
| `getRunDetail` / `GET /runs/:id` | masked | masked |
| `testStep` output | masked | kept (the caller is an authorized editor) |

`createEngine({ redact })` applies a final scrub to every event.

## Storage adapters

| Package | Use |
|---|---|
| `@flowkit/storage-memory` | Tests, examples and single-process development. Data is lost when the process exits. |
| `@flowkit/storage-postgres` | Production. Run `migrate(pool, schema?)` first. Leasing uses `FOR UPDATE SKIP LOCKED`, so any number of workers can share one database. Postgres cannot store NUL bytes (`\u0000`) in strings, so they raise `FlowkitStorageError`. |

To write your own adapter, implement `StorageAdapter` from `@flowkit/engine`, then check it against
the conformance suite (it requires Vitest):

```ts file=my-storage.conformance.ts
import { runStorageConformance } from "@flowkit/engine/testing";
import { createMyStorage } from "./my-storage";

runStorageConformance("my-storage", async () => {
  const storage = await createMyStorage();
  return { storage, cleanup: () => storage.close() };
});
```

## Security notes

- **Authorization.** Every editor route goes through `authorize(req)`, which returns
  `{ tenantId, userId }` or `null` (a 401). Without `authorize`, every request acts as tenant
  `"default"` and the engine logs a warning. Always set it in production. Each tenant can see only
  its own data.
- **SSRF.** `ctx.http.fetch`, which `core.httpRequest` uses, blocks private, loopback and
  link-local addresses. It checks every redirect hop. You can configure it with
  `createEngine({ http: { allowPrivateNetworks, allowHosts, maxResponseBytes } })`. Credential
  headers are removed when a redirect goes to another origin.
- **HTTP credentials.** In `core.httpRequest`, set `auth` to
  `{ type: "none" | "bearer" | "basic" | "header", secret, headerName? }`. `secret` is the name of a
  secret, and `ctx.secrets` resolves it at runtime. Its value never appears in docs, journals or
  events.
- **The transform sandbox.** `core.transform` runs user JavaScript in QuickJS (WebAssembly), with
  limits on memory (64 MB), time (1 s) and stack. The code has no access to the network, the file
  system or timers. Its result goes through JSON, and any key named `__proto__`, `constructor` or
  `prototype` is dropped. To swap the runtime, pass `createEngine({ transform })`. QuickJS runs
  synchronously, so a transform blocks the worker's event loop for up to its time limit. If
  transforms are heavy and the API and the worker share a process, run the worker in its own
  process.
- **Secrets.** Secrets come from your `secrets.get(tenantId, name)`. The editor sees only secret
  names, from `secrets.list`.

## Editor

`@flowkit/react` gives you these components:

- `<WorkflowEditor workflowId>`, which has a `renderPanel` slot for the side panel of the selected
  step.
- `<RunViewer runId>`
- `<RunList onSelect>`
- `<FlowkitProvider>`

The provider accepts `client`, `theme`, `labels`, `icons` and `widgets`.

- **Styles.** Import `@flowkit/react/styles.css`. All the rules sit in `@layer flowkit`, so your own
  CSS wins without any specificity fights.
- **Theme.** Set `theme={{ colorMode: "dark", tokens: { accent: "#0f766e" } }}`, or override the
  `--fk-*` custom properties directly.
- **Labels.** `labels` overrides any visible or accessible text, for translations or rewording.
- **Icons.** `icons` maps a manifest icon name to a component. A set of common Lucide icons is
  included (see `bundledIconNames`).
- **Widgets.** `widgets` registers custom config-field controls, selected by
  `ui(schema, { widget })`. See the [plugin guide](docs/guides/writing-a-plugin.md#custom-widgets).

## Testing

`@flowkit/engine/testing` exports `testNode`, which runs one handler, and `runWorkflowInMemory`,
which saves, publishes, starts and drains a doc, skipping through timers. `runWorkflowInMemory`
needs `@flowkit/storage-memory`, which is an optional peer dependency of the engine, so install it
as a dev dependency. See [Testing your plugin](docs/guides/writing-a-plugin.md#testing).

## Examples

- [`examples/headless`](examples/headless): a plugin, a workflow built in code and an in-memory
  engine. It prints the run's audit log. Run it with `pnpm --filter headless start`.
- [`examples/mini-crm`](examples/mini-crm): a Vite and React app with a Hono server. It includes a
  CRM plugin, sub-flows, webhook lead routing, a manager approval step and the run viewer.

## Packages

| Package | What it contains |
|---|---|
| `@flowkit/core` | `defineNode`, `defineTrigger`, `definePlugin`, `createRegistry`, the doc types, references, the validator, the `workflow()` builder, and `@flowkit/core/client`. Isomorphic, with no I/O. |
| `@flowkit/nodes-builtin` | The `core.*` nodes and triggers, and the rule helpers (`and`, `eq`, `isTrue`, ...). |
| `@flowkit/engine` | `createEngine`: the interpreter, workers, HTTP handler, triggers, SSE and the QuickJS runtime. `@flowkit/engine/testing` holds the test helpers. |
| `@flowkit/storage-memory` | The in-memory `StorageAdapter`. |
| `@flowkit/storage-postgres` | The Postgres `StorageAdapter` and `migrate`. |
| `@flowkit/react` | The editor, run viewer, run list, hooks and theme. |

## Roadmap

These are out of scope for v1, but the design leaves room for them:

- A Redis adapter
- Parallel blocks
- Drag-to-map
- OAuth connection management
- A Temporal or Inngest backend
- An import/export UI
- Internationalization beyond labels
- References to steps inside a branch after it rejoins

## Development

```sh
pnpm install
pnpm test          # vitest across all packages and examples
pnpm -r typecheck
pnpm lint          # biome
pnpm build         # tsup
```

`pnpm test` includes `examples/docs-check`, which checks the docs in two ways:

- It extracts every `ts` or `tsx` block in this README and in the plugin guide, and typechecks
  them. A block's fence names its file, for example `ts file=flowkit/nodes.ts`. Blocks from the
  same document can import each other. Add `nocheck` to the fence to skip a block.
- It runs the quick start on memory storage.

If you add a TypeScript block without an annotation, the check fails.

The design spec is `docs/superpowers/specs/2026-09-27-flowkit-design.md`.

MIT licensed.
