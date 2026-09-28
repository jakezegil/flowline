# Flowline

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
pnpm add @flowlinejs/core @flowlinejs/nodes-builtin @flowlinejs/engine @flowlinejs/storage-postgres zod@^4 pg
pnpm add hono @hono/node-server # or any other fetch-style server
pnpm add @flowlinejs/react react react-dom # the editor (step 7), in your React app
pnpm add -D @types/react @types/react-dom vite @vitejs/plugin-react # or your own bundler
pnpm add -D @flowlinejs/storage-memory # for tests and prototypes
```

`zod` 4 is a peer dependency of `@flowlinejs/core`, `@flowlinejs/nodes-builtin` and `@flowlinejs/engine`:
install it once, so your schemas and flowline's share one copy. Zod 3 is not supported. If a
second copy slips in (typically a `link:`/`file:` dependency on a flowline checkout, which resolves
its own zod), `createRegistry` throws a `FlowlineDefinitionError` naming the field whose
`ui()`/`secret()`/`sensitive()` metadata it can't read, rather than dropping those guarantees.
Dedupe zod (`pnpm dedupe`, or an `overrides` entry), or install a packed tarball instead.

### 1. Define a node

```ts file=flowline/nodes.ts
// flowline/nodes.ts
import { defineNode, ui } from "@flowlinejs/core";
import { z } from "zod";
import type { Db } from "../db";

// Type ctx.services once, for every handler.
declare module "@flowlinejs/core" {
  interface FlowlineServices {
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

```ts file=flowline/plugin.ts
// flowline/plugin.ts
import { createRegistry, definePlugin, defineTrigger } from "@flowlinejs/core";
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

```ts file=flowline/engine.ts
// flowline/engine.ts
import { createEngine } from "@flowlinejs/engine";
import { createPostgresStorage, migrate } from "@flowlinejs/storage-postgres";
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

For tests and prototypes, use `createMemoryStorage()` from `@flowlinejs/storage-memory` instead.

### 4. Mount the HTTP handler

`engine.handler` is a `(Request) => Promise<Response>` function, so it works with any server that
speaks `fetch`. It serves every route under `basePath`. The default is `/flowline`, and you can
change it with `createEngine({ basePath })`. Mount the handler at the same path. This example uses
Hono:

```ts file=server.ts
// server.ts
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { engine } from "./flowline/engine";

const app = new Hono();
app.all("/flowline/*", (c) => engine.handler(c.req.raw));
serve({ fetch: app.fetch, port: 3000 });
```

### 5. Start a worker

```ts file=worker.ts
// worker.ts (or at the end of server.ts)
import { engine } from "./flowline/engine";

export const worker = engine.startWorker({ concurrency: 4 });
process.on("SIGTERM", () => void worker.stop()); // waits for in-flight steps
```

The worker can share a process with the API or run on its own. Every worker polls the same
storage, so you can run as many as you need.

### 6. Publish a workflow

Triggers only start *published* workflows. You can build and publish a workflow in the editor
(step 7), or in code:

```ts file=flowline/workflows.ts
// flowline/workflows.ts
import { ref, workflow } from "@flowlinejs/core";
import { engine } from "./engine";
import { loadContact } from "./nodes";
import { contactCreated } from "./plugin";

export const welcomeContact = workflow("welcome-contact", { name: "Welcome new contacts" })
  .trigger(contactCreated)
  .step("contact", loadContact, { contactId: ref("trigger.contactId") })
  .build();

/** Save a new version and publish it. Throws FlowlineValidationError if the doc is invalid. */
export async function publishWorkflows(tenantId: string) {
  const { version } = await engine.saveWorkflow(tenantId, welcomeContact, "setup");
  await engine.publish(tenantId, welcomeContact.id, version, "setup");
}
```

### 7. Embed the editor

```tsx file=WorkflowPage.tsx
// WorkflowPage.tsx
import { createClient } from "@flowlinejs/core/client";
import { FlowlineProvider, WorkflowEditor } from "@flowlinejs/react";
import "@flowlinejs/react/styles.css";

const client = createClient({ baseUrl: "/flowline" });

export function WorkflowPage() {
  return (
    <FlowlineProvider client={client}>
      <div style={{ height: "100vh" }}>
        <WorkflowEditor workflowId="welcome-contact" />
      </div>
    </FlowlineProvider>
  );
}
```

This page opens the workflow from step 6. Users can edit it and publish new versions from the
editor's header. For a `workflowId` that doesn't exist, the editor shows "Workflow not found"
with a "Go back" button, so a mistyped link can't create a workflow under the typo. To start
a new workflow instead:

- `create` opens a new draft without loading anything. It starts from `initialDoc`, or a blank
  workflow with a manual trigger. The first save creates the workflow, and only if the ID is
  still free.
- `initialDoc` alone is the starting doc when the ID turns out not to exist.
- `notFoundAction` replaces the not-found button: your own `{ label, onClick }` (e.g. back to
  your list), `"create"` for "Create this workflow", or `null` for none.

Reloading or closing the tab with unsaved changes asks the browser to confirm. Navigation inside
your app is your router's, so guard it with `onDirtyChange`, which reports whether there are
unsaved changes. With React Router (a data router, for `useBlocker`):

```tsx nocheck
const [dirty, setDirty] = useState(false);
const blocker = useBlocker(dirty);
// …
<WorkflowEditor workflowId={id} onDirtyChange={setDirty} />
{blocker.state === "blocked" && (
  <ConfirmLeave onLeave={() => blocker.proceed()} onStay={() => blocker.reset()} />
)}
```

The mini-crm example does this in `web/src/pages/workflow-edit.tsx`. The editor doesn't keep a
local draft to recover after a reload: workflow configs can hold customer data, which shouldn't
sit in `localStorage`. Save often instead.

If your engine allows private networks or restricts outbound hosts, pass the same policy as
`network` (`{ allowPrivateNetworks, allowHosts }`), so URL fields warn exactly where publishing will.

The editor and viewer add a few hundred KB of JavaScript (CodeMirror and React Flow). Load the
editor route lazily, with `React.lazy(() => import("./WorkflowPage"))`, so the rest of your app
doesn't wait for it.

The browser receives only the JSON manifest. `@flowlinejs/core` and `@flowlinejs/react` never import
the engine or any server-only code.

### 8. Start runs from your app

```ts file=app.ts
// app.ts, e.g. wherever your app creates contacts
import { engine } from "./flowline/engine";
import { publishWorkflows } from "./flowline/workflows";

await publishWorkflows("acme"); // once, at deploy or startup. Each call saves a new version.
await engine.emit("contact.created", { contactId: "c_42" }, { tenantId: "acme" });
```

`emit` starts every published workflow whose trigger listens for the event and resolves
`{ started, rejected }`: `started` is the new run IDs, and `rejected` reports any match whose
trigger rejected the payload (or whose `filter`/`dedupeKey` threw) without blocking the others from
starting. The worker then runs the steps. To see the completed run, use `GET /flowline/runs` or
`<RunList>` and `<RunViewer>`. For a workflow with a manual trigger, call
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

```ts file=flowline/welcome-vip.ts
// flowline/welcome-vip.ts
import { ref, workflow } from "@flowlinejs/core";
import {
  and,
  conditionNode,
  delayNode,
  isTrue,
  manualTrigger,
  stopNode,
} from "@flowlinejs/nodes-builtin";
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
      if: (b) => b.step("wait", delayNode, { duration: "1d" }),
      else: (b) => b.step("halt", stopNode, { reason: "Not a VIP" }),
    },
  )
  // The branches rejoin here: only VIPs get this far, a day later.
  .step("refresh", loadContact, { contactId: ref("steps.contact.id") })
  .build();

const { version } = await engine.saveWorkflow("acme", doc, "user_1");
await engine.publish("acme", doc.id, version, "user_1"); // throws FlowlineValidationError if invalid
```

This uses only the quick start's `crm.loadContact` and built-in nodes, so it publishes against
the engine from step 3. `examples/docs-check` publishes it on every `pnpm test`.

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
  to retry. Both classes are exported from `@flowlinejs/core` and from `@flowlinejs/engine`. If the input
  or output fails schema validation, the step fails at once.
- `engine.retryRun` continues a failed run from its failed step. `engine.cancelRun` cancels a run
  that is queued or waiting at once. If a worker is running the run, it cancels at the next
  checkpoint.

### Suspend and resume

A handler can return `suspend({ until })` to wait until a time, or `suspend({ callback })` to wait
for an HTTP call. When the run resumes, the engine calls the same handler again, with
`ctx.resume` set to one of `timer`, `callback`, `timeout`, `subflow` or `subflowFailed`.

```ts file=flowline/approval.ts
import { defineNode, suspend } from "@flowlinejs/core";
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
- Declare how a waiting node is resumed with `resume` on its definition. `resume.body` is a Zod
  schema for the callback body. The engine checks every resume against it (token route,
  authorized route and `engine.resume`/`engine.resumeRun`) and rejects a mismatch with 400 or a
  `FlowlineValidationError`; the run viewer's Resume dialog starts empty and checks it too.
  `resume.hostHandled: true` (with an optional `hint`) means your app resumes it, for example
  from an approvals page: `POST <basePath>/runs/:id/resume` answers 409 with
  `code: "resume_host_handled"`, and the viewer shows the hint instead of Resume…. Your own code
  still resumes it with `engine.resumeRun` (only the generic route passes `refuseHostHandled`).
  The public token route (`POST <basePath>/resume/:token`, `engine.resume`) resumes it too: a
  callback token is a bearer capability, so never expose the token or `resumeUrl` of a
  host-handled step. A resume the engine can't check (the pinned version, the step or its node
  type is missing) is refused with 409 `resume_unverifiable`.
  Hosts can also hide or replace the viewer's action with `<RunViewer resumeAction={…}>`.
- `core.waitForCallback` has an optional `notify: { url }`. Once the wait is committed, the engine
  POSTs `{ resumeUrl, expiresAt, runId }` to that URL, with redirects refused.

### Triggers

- **Events.** `engine.emit(event, payload, { tenantId, dedupeKey? })` starts a run for each
  matching trigger and resolves `{ started, rejected }`. Each match is validated independently: an
  invalid payload, or a `filter`/`dedupeKey` that throws, adds an entry to `rejected` (also logged
  at `warn`, and reported through `onTriggerEvent` as `trigger.rejected`) without blocking the
  other matches from starting. A trigger can also define `filter` and `dedupeKey`.
- **Webhooks.** `POST <basePath>/hooks/:tenantId/:workflowId/:slug` starts a run. The engine
  generates the slug on the first save. You can add an HMAC check with
  `X-Flowline-Signature: sha256=<hex>`. The engine never stores the `authorization`, `cookie`,
  signature or `proxy-*` headers. The webhook responds as follows:

  | Case | Response |
  |---|---|
  | A new run started | 202 `{ runId }` |
  | The dedupe header was a repeat | 200 `{ runId, deduped: true }` |
  | The trigger's `filter` rejected the delivery | 200 `{ skipped: true }` |
  | The slug is unknown | 404 |
  | The signature is bad | 401 |
  | The body does not match the declared fields | 400 `{ issues }` |
- **Schedules.** Cron expressions with a time zone. Schedules do not catch up after downtime: only
  the most recent missed fire runs.
- **Deduplication.** Dedupe keys are scoped to a workflow. Each key claims a randomly generated run
  ID for a dedupe window; a repeat delivery within that window gets the same run ID back, and a
  delivery after the window expires starts a new run with a fresh ID.

### Calling a webhook

A webhook workflow declares the body fields it expects, and optionally a signing secret and a
deduplication header:

```ts file=flowline/webhook.ts
// flowline/webhook.ts
import { createHmac } from "node:crypto";
import { ref, workflow } from "@flowlinejs/core";
import { webhookTrigger } from "@flowlinejs/nodes-builtin";
import { engine } from "./engine";
import { loadContact } from "./nodes";

export const leadReceived = workflow("lead-received", { name: "Lead received" })
  .trigger(webhookTrigger, {
    fields: [{ name: "contactId", type: "string", required: true }],
    secret: "partner-webhook", // a secret's *name*; the engine calls secrets.get(tenantId, name)
    dedupeHeader: "X-Request-Id", // a repeated value returns the first run instead of a new one
  })
  // The payload is { body, headers }: declared fields are under trigger.body.
  .step("contact", loadContact, { contactId: ref("trigger.body.contactId") })
  .build();

/** Publish the workflow and return its webhook URL. */
export async function publishLeadWebhook(tenantId: string): Promise<string> {
  const saved = await engine.saveWorkflow(tenantId, leadReceived, "setup");
  await engine.publish(tenantId, saved.workflowId, saved.version, "setup");
  // The engine generates the slug on the first save and keeps it in later versions.
  const slug = String(saved.doc.trigger.config.slug);
  return `https://app.example.com/flowline/hooks/${tenantId}/${saved.workflowId}/${slug}`;
}

/** What the sending system does: sign the exact body bytes with the secret's value. */
export function signedRequest(url: string, signingKey: string, requestId: string): Request {
  const body = JSON.stringify({ contactId: "c_42" });
  const signature = createHmac("sha256", signingKey).update(body).digest("hex");
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-flowline-signature": `sha256=${signature}`,
      "x-request-id": requestId,
    },
    body,
  });
}
```

Send the request with `fetch(signedRequest(url, key, id))`. The signature is HMAC-SHA256 of the
raw request body, keyed with the value `secrets.get` returns for the secret's name, so sign the
bytes you send, not a re-serialized copy. A signing secret must be a literal name: a reference
there is a validation error. The responses are listed under [Triggers](#triggers).

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
| `@flowlinejs/storage-memory` | Tests, examples and single-process development. Data is lost when the process exits. |
| `@flowlinejs/storage-postgres` | Production. Run `migrate(pool, schema?)` first. Leasing uses `FOR UPDATE SKIP LOCKED`, so any number of workers can share one database. Postgres cannot store NUL bytes (`\u0000`) in strings, so they raise `FlowlineStorageError`. |

To write your own adapter, implement `StorageAdapter` from `@flowlinejs/engine`, then check it against
the conformance suite (it requires Vitest):

```ts file=my-storage.conformance.ts
import { runStorageConformance } from "@flowlinejs/engine/conformance";
import { createMyStorage } from "./my-storage";

runStorageConformance("my-storage", async () => {
  const storage = await createMyStorage();
  return { storage, cleanup: () => storage.close() };
});
```

## Security notes

- **Authorization.** Every editor route goes through `authorize(req)`, which returns
  `{ tenantId, userId }` or `null` (a 401). Every editor request other than `GET` must send
  `Content-Type: application/json`, even when it has no body. Otherwise the engine returns 415.
  This check keeps cookie-authorized mutations safe from CSRF. `@flowlinejs/core/client` sets the
  header for you. Without `authorize`, every request acts as tenant
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
  names, from `secrets.list`, and validation warns about a name that isn't listed. `secret()`
  fields are literal-only: the validator and the engine both refuse a reference there, so trigger
  data can't pick which tenant secret is resolved and sent.

## Editor

`@flowlinejs/react` gives you these components:

- `<WorkflowEditor workflowId>`, which has a `renderPanel` slot for the side panel of the selected
  step.
- `<RunViewer runId>`
- `<RunList onSelect>`
- `<FlowlineProvider>`

The provider accepts `client`, `theme`, `labels`, `icons` and `widgets`.

- **Styles.** Import `@flowlinejs/react/styles.css`. All the rules sit in `@layer flowline`, so your own
  unlayered CSS wins without any specificity fights. That includes global resets like
  `button { color: inherit }`, so put those in a layer ordered before `flowline`
  (`@layer reset, flowline;`). See [Styles and cascade layers](packages/react/README.md#styles-and-cascade-layers).
- **Theme.** Set `theme={{ colorMode: "dark", tokens: { accent: "#0f766e" } }}`, or override the
  `--fl-*` custom properties directly.
- **Labels.** `labels` overrides any visible or accessible text, for translations or rewording.
- **Icons.** `icons` maps a manifest icon name to a component. A set of common Lucide icons is
  included (see `bundledIconNames`). Any other name, or a URL, shows a generic box until you
  add it to `icons`.
- **Widgets.** `widgets` registers custom config-field controls, selected by
  `ui(schema, { widget })`. See the [plugin guide](docs/guides/writing-a-plugin.md#custom-widgets).

## Testing

`@flowlinejs/engine/testing` exports `testNode`, which runs one handler, and `runWorkflowInMemory`,
which saves, publishes, starts and drains a doc, skipping through timers. `runWorkflowInMemory`
needs `@flowlinejs/storage-memory`, which is an optional peer dependency of the engine, so install it
as a dev dependency. Besides `plugins`, `services`, `trigger` and `clock`, it takes `secrets`
(values by name, for `ctx.secrets`), `http` (the network policy; `{ allowPrivateNetworks: true }`
reaches a local mock server) and `subflows` (docs published before the workflow that calls them).
See [Testing your plugin](docs/guides/writing-a-plugin.md#testing). `@flowlinejs/engine/testing`
never imports `vitest`; the storage conformance suite (`runStorageConformance`, see above) is its
own entry point, `@flowlinejs/engine/conformance`, because it does.

## Examples

- [`examples/headless`](examples/headless): a plugin, a workflow built in code and an in-memory
  engine. It prints the run's audit log. Run it with `pnpm --filter headless start`.
- [`examples/mini-crm`](examples/mini-crm): a Vite and React app with a Hono server. It includes a
  CRM plugin, sub-flows, webhook lead routing, a manager approval step, the embedded editor and
  the run viewer. Run it with `pnpm --filter @flowlinejs/example-mini-crm dev` and open
  `http://localhost:5173`.

## Packages

| Package | What it contains |
|---|---|
| `@flowlinejs/core` | `defineNode`, `defineTrigger`, `definePlugin`, `createRegistry`, the doc types, references, the validator, the `workflow()` builder, and `@flowlinejs/core/client`. Isomorphic, with no I/O. |
| `@flowlinejs/nodes-builtin` | The `core.*` nodes and triggers, and the rule helpers (`and`, `eq`, `isTrue`, ...). |
| `@flowlinejs/engine` | `createEngine`: the interpreter, workers, HTTP handler, triggers, SSE and the QuickJS runtime. `@flowlinejs/engine/testing` holds the test helpers; `@flowlinejs/engine/conformance` holds the storage conformance suite. |
| `@flowlinejs/storage-memory` | The in-memory `StorageAdapter`. |
| `@flowlinejs/storage-postgres` | The Postgres `StorageAdapter` and `migrate`. |
| `@flowlinejs/react` | The editor, run viewer, run list, hooks and theme. |

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
  them. A block's fence names its file, for example `ts file=flowline/nodes.ts`. Blocks from the
  same document can import each other. Add `nocheck` to the fence to skip a block.
- It runs the quick start on memory storage.

If you add a TypeScript block without an annotation, the check fails.

The design spec is `docs/superpowers/specs/2026-09-27-flowline-design.md`.

### Releasing

Releases go through [Changesets](https://github.com/changesets/changesets): run `pnpm changeset`
to add one, and `.github/workflows/release.yml` opens or updates a "Version Packages" PR on every
push to `main` with pending changesets, then publishes once that PR is merged (via
`changesets/action`, gated on the repo's own `install`/`build`/`test`/`typecheck`/`lint` run).

**Do not add the `NPM_TOKEN` secret until a first publish is explicitly approved.** With no
pending changesets, the first push to `main` after the secret exists publishes the current
versions immediately — see the comment at the top of `.github/workflows/release.yml`.

MIT licensed.
