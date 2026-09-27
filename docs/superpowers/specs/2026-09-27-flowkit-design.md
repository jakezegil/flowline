# Flowkit — Design Spec

**Date:** 2026-09-27
**Status:** Approved in brainstorming; pending written-spec review
**Name:** "flowkit" is a working name (package scope `@flowkit/*`).

## 1. Purpose & success criteria

An open-source TypeScript library for defining workflow plugins/nodes, composing them into automations on a visual canvas (Zapier/n8n-style), and executing them durably with a full audit trail. Primary consumer: a CRM that embeds the editor and runtime and registers its own nodes. Many different developers will consume it, so developer experience is the top priority.

Success means:
- A developer defines a fully typed node in ~10 lines; types flow from Zod schemas into handler input, the editor's config form, and the data picker.
- A host app mounts a working editor (`<WorkflowEditor>`) and runtime (`createEngine`) with minimal glue: one HTTP handler, one worker call.
- Runs survive process crashes, resume after waits/webhooks, and produce an auditable event history.
- The editor is beautiful and highly usable for non-developer CRM operators.

### Stated requirements
Entity loading for later steps; sub-flows (get / create / getOrCreate); conditions and stops; switch/case; external webhooks; durable, auditable execution; backend + frontend; example use cases in-repo.

### Assumptions (confirmed)
TypeScript end-to-end; React for UI; Zod for schemas; monorepo of focused packages; host app owns auth, storage choice, and entity types.

## 2. Key decisions

| Decision | Choice |
|---|---|
| Durability | Built-in durable engine with pluggable, storage-agnostic adapters (not Temporal/Inngest). |
| Data mapping | Typed references + `{{ }}` interpolation for config fields; a sandboxed Transform node for real logic. No general expression language. |
| Sub-flows | Workflows with typed input/output schemas, callable as nodes; execute as linked child runs. |
| Webhooks | Inbound trigger, outbound HTTP node, and wait-for-callback (suspend/resume). |
| Other triggers | CRM events (host-emitted), manual, schedule (cron). |
| Graph shape | Structured tree (Zapier/HubSpot/Activepieces-style): sequential steps, branch blocks with nested step lists that rejoin. No free-form wiring. |
| Canvas | React Flow (`@xyflow/react` v12) with a custom deterministic tree layout. |
| Transform sandbox | QuickJS via `quickjs-emscripten` (WASM), behind a pluggable `TransformRuntime` interface. |

## 3. Packages

pnpm workspaces, tsup builds (ESM + d.ts), Vitest, TypeScript strict.

| Package | Responsibility | Depends on |
|---|---|---|
| `@flowkit/core` | `defineNode`, `defineTrigger`, `definePlugin`, `createRegistry`; workflow document schema & types; reference/interpolation resolution; validator & reference type-checker; tree mutation helpers; manifest serialization (Zod → JSON Schema); code-first `workflow()` builder. Pure and isomorphic — no I/O. | `zod` |
| `@flowkit/nodes-builtin` | condition, switch, forEach, stop, delay, waitForCallback, httpRequest, transform, callSubflow; built-in triggers (event, webhook, manual, schedule, subflow). | core |
| `@flowkit/engine` | `createEngine`; executor/interpreter; workers; `StorageAdapter` interface + `runStorageConformance`; HTTP `handler`; trigger dispatch; timers; secrets/redaction; `TransformRuntime` (QuickJS default); testing helpers (`testNode`, `runWorkflowInMemory`); `createClient` HTTP client for the editor. | core, nodes-builtin |
| `@flowkit/storage-memory` | In-memory adapter (tests, examples). | engine (types only) |
| `@flowkit/storage-postgres` | Postgres adapter (`pg`), migrations, `FOR UPDATE SKIP LOCKED` leasing. | engine (types only) |
| `@flowkit/react` | Headless store/hooks, tree layout, `<WorkflowEditor>`, `<RunViewer>`, default skin and theme tokens. | core, `@xyflow/react`, `zustand` |

The client-side packages (`core`, `react`) must never import handler code; the browser only receives the **manifest**.

## 4. Definition API (core)

### 4.1 Nodes

```ts
export const loadContact = defineNode({
  type: "crm.loadContact",          // globally unique, namespaced by plugin
  name: "Load contact",
  description: "Fetch a contact by ID",
  icon: "user",                      // lucide icon name or URL
  category: "Contacts",
  input: z.object({ contactId: z.string().describe("Contact ID") }),
  output: ContactSchema,
  summary: (input) => `Load contact ${input.contactId}`,
  retry: { max: 3, backoff: "exponential" },   // optional
  async run({ input, ctx }) {
    return ctx.services.db.contacts.get(input.contactId);
  },
});
```

- `input` / `output` are Zod object schemas. `run` receives `z.infer<input>` after references are resolved and the resolved input is validated; its return is validated against `output`.
- UI metadata via `.describe()` and a `ui(schema, { widget, placeholder, group, sensitive, secret })` helper that attaches metadata to a Zod schema (stored in a WeakMap-backed registry, serialized into the manifest).
- Branching nodes declare `branches`: static (`["if", "else"]`) or dynamic from config (`(config) => [...config.cases.map(c=>c.id), "default"]`).
- Handlers may return `suspend(...)` (see §5.4) or a `{ branch, output }` result for branching nodes.

### 4.2 Triggers

```ts
export const dealUpdated = defineTrigger({
  type: "crm.dealUpdated",
  name: "Deal updated",
  kind: "event",                 // "event" | "webhook" | "manual" | "schedule" | "subflow"
  event: "deal.updated",
  config: z.object({ onlyWhenStageChanges: z.boolean().default(false) }),
  payload: DealUpdatedPayload,   // becomes `trigger` in reference scope
  filter: ({ config, payload }) => !config.onlyWhenStageChanges || payload.changes.includes("stage"),
});
```

### 4.3 Plugins and registry

```ts
export const crmPlugin = definePlugin({
  id: "crm",
  name: "CRM",
  icon: "building",
  nodes: [loadContact, updateDeal, assignOwner, sendEmail],
  triggers: [contactCreated, dealUpdated],
});
const registry = createRegistry([builtinPlugin, crmPlugin]);
registry.manifest(); // JSON-serializable: plugins, nodes (JSON Schema for input/output), triggers
```

Services are injected once at engine creation (`createEngine({ services })`) and typed on `ctx.services` via module augmentation (`declare module "@flowkit/core" { interface FlowkitServices { db: Db } }`).

### 4.4 Workflow document

```ts
type WorkflowDoc = {
  id: string; name: string; description?: string;
  trigger: { type: string; config: unknown };
  steps: Step[];
  // for sub-flows: output mapping evaluated at end of run
  output?: Record<string, ValueExpr>;
};
type Step = {
  id: string;            // stable, unique within doc, used in references
  type: string;          // node type
  name?: string;         // user-facing label override
  disabled?: boolean;    // skipped at runtime, faded in editor
  config: Record<string, ValueExpr>;
  branches?: Record<string, Step[]>;   // for branching/looping nodes (forEach uses "body")
};
type ValueExpr = Literal | { $ref: string } | { $tpl: string } | ValueExpr[] | { [k: string]: ValueExpr };
```

- `$ref` path grammar: `trigger.<path>`, `steps.<stepId>.<path>`, `loop.item.<path>`, `loop.index`, `run.id`. Paths use dot notation with `[n]` indices.
- `$tpl` strings interpolate `{{ <ref path> }}`; result is always a string.
- Scope rule: a step may reference the trigger, any earlier sibling in its own step list, and — recursively — any earlier sibling of each enclosing branch block (including the enclosing block itself, e.g. a forEach's `loop.*`). Steps inside a branch are **not** visible after the block rejoins; only the block's own output is.
- Versions: saving creates an immutable `WorkflowVersion { workflowId, version, doc, createdBy, createdAt }`. A workflow has at most one `publishedVersion`; triggers only start published versions. Runs pin `(workflowId, version)`.

### 4.5 Validation

`validateWorkflow(doc, registry) → Issue[]` where `Issue = { stepId?, field?, code, message, severity }`. Checks: unknown node/trigger types; unique step IDs; required config fields present; literal values valid for the field schema; every `$ref` resolves in scope; the referenced output schema type is assignable to the field's input type (JSON-Schema-level structural check: primitive kinds, arrays, objects, optional/nullable); branch keys match declared branches; subflow references exist and inputs match. The same validator runs in the editor (live) and on the server (publish is rejected if any `error` issues).

### 4.6 Code-first builder

```ts
const dealWon = workflow("deal-won", { name: "Deal won follow-up" })
  .trigger(dealUpdated, { onlyWhenStageChanges: true })
  .step("check", condition({ rules: [eq(ref("trigger.deal.stage"), "won")] }), {
    if: (b) => b.step("wait", delay({ duration: "2d" }))
                .step("email", sendEmail({ to: ref("trigger.deal.owner.email"), subject: tpl("Congrats on {{trigger.deal.name}}") })),
    else: (b) => b.step("halt", stop({ reason: "Not won" })),
  })
  .build(); // → WorkflowDoc
```

## 5. Engine

### 5.1 Creation & hosting

```ts
const engine = createEngine({
  registry, storage, services,
  secrets: { get: (tenantId, name) => vault.get(tenantId, name) },
  authorize: async (req) => ({ tenantId, userId }),   // for editor API
  redact: (event) => event,                           // optional PII scrubbing
  transform: quickjsRuntime(),                        // optional; default QuickJS
  onEvent: (e) => sse.broadcast(e),                   // optional
});
engine.startWorker({ concurrency: 4, pollMs: 500 });   // returns stop()
app.all("/flowkit/*", (c) => engine.handler(c.req.raw)); // (Request) => Promise<Response>
await engine.emit("deal.updated", payload, { tenantId });
await engine.start({ tenantId, workflowId, input });   // manual
```

### 5.2 Run model

`Run { id, tenantId, workflowId, version, status, cursor, scope, parentRunId?, parentStepId?, wakeAt?, callbackToken?, leaseOwner?, leaseUntil?, attempt, error?, output?, createdAt, updatedAt }`

- `status`: `queued | running | waiting | completed | failed | cancelled`.
- `cursor`: path into the tree identifying the next step (e.g. `[["route","web",0]]` path segments incl. loop iteration indices).
- `scope`: journal of committed step outputs keyed by step path (`lookup`, `loop[3].email`), plus `trigger`.

### 5.3 Execution loop

1. Worker calls `storage.claimRun(workerId, leaseMs)` → a runnable run (`queued`, or `waiting` with `wakeAt <= now`, or `running` with expired lease).
2. Interpreter computes the next step from `cursor` + `scope`, resolves its config refs against scope, validates input, emits `step.started`, calls the handler with `ctx { runId, stepId, tenantId, attempt, idempotencyKey, services, secrets, logger, signal }`.
3. On success: `storage.commitStep(runId, leaseToken, { stepPath, output, nextCursor, events })` — atomic journal append + cursor advance + event append, guarded by the lease token (fails if lease was lost).
4. Loop until the run completes, suspends, fails, or a per-claim step budget is hit (then release and re-queue for fairness).
5. Branching nodes return `{ branch, output }`; the cursor descends into that branch; at branch end the cursor rejoins after the block.
6. `forEach` iterates its `body` sequentially; iteration outputs journaled under `loop[i]`; the forEach step's output is `{ items: <per-iteration last output>[], count }`.

Guarantees: committed steps never re-execute. A crash during a step may re-run that step (**at-least-once**); `ctx.idempotencyKey = hash(runId, stepPath)` is stable across attempts for handlers to pass to external systems.

### 5.4 Suspension

A handler returns `suspend({ until: Date })` or `suspend({ callback: { timeoutMs, schema? } })`. Engine sets run `waiting` and `wakeAt`; for callbacks it generates a single-use, expiring `callbackToken`. The token must be deliverable to the outside world, so `ctx.callback()` returns `{ token, resumeUrl, expiresAt }` to the handler *before* it returns `suspend(...)` — the handler (e.g. waitForCallback's optional `notify` config, or a CRM node that emails an approver) can send it out. The engine journals this under `steps.<id>.pending` so it's visible in the run viewer. On resume the step's final output is `{ body, timedOut }`. Resume via `POST /flowkit/resume/:token` or `engine.resume(token, body)`. Timeout → run wakes with `timedOut: true`; waitForCallback routes to its `timeout` branch.

### 5.5 Retries & errors

Per-node `retry { max, backoff: "fixed"|"exponential", initialMs }` (default: max 3, exponential from 1s). `RetryableError` → schedule retry via `wakeAt`; `FatalError` → fail immediately; unknown errors → retryable. Input/output schema validation failures are fatal. Exhausted retries → run `failed`, with `step.failed` event. `engine.retryRun(runId, { fromFailedStep: true })` resumes a failed run from the failed step.

### 5.6 Sub-flows

`callSubflow` creates a child run (`parentRunId`, `parentStepId`) for the sub-flow's published version with validated input, then suspends the parent. When the child completes, the engine evaluates the child's `output` mapping, validates against the subflow trigger's output schema, commits it as the parent step's output and makes the parent runnable. Child failure fails the parent step (subject to its retry policy: a retry starts a new child run).

### 5.7 Audit events

Append-only `RunEvent { id, runId, tenantId, seq, type, stepPath?, at, workerId?, data }` with types: `run.started, step.started, step.completed, step.failed, step.retrying, run.suspended, run.resumed, run.completed, run.failed, run.cancelled, run.stopped`. `step.completed.data` contains resolved input and output (after `redact` and removal of `sensitive`/`secret` fields). Workflow saves/publishes produce `WorkflowAuditEntry { workflowId, version, action, actor, at }`.

### 5.8 StorageAdapter interface

Methods (all tenant-scoped where applicable):
`saveWorkflowVersion, getWorkflowVersion, getPublishedVersion, publishVersion, listWorkflows, listWorkflowAudit, createRun, getRun, listRuns, claimRun, commitStep, suspendRun, failRun, completeRun, releaseRun, resumeByToken, wakeParent, appendEvents, listEvents, findPublishedByTrigger, recordDedupeKey`.

`runStorageConformance(makeAdapter)` (exported from `@flowkit/engine/testing`) verifies: exclusive claims under concurrency, lease expiry reclaim, commit rejection with stale lease, wake-at ordering, single-use callback tokens, dedupe, event ordering by `seq`.

### 5.9 HTTP handler routes (under a configurable base path)

- `GET  /manifest`
- `GET  /workflows`, `GET /workflows/:id`, `PUT /workflows/:id` (save new version), `POST /workflows/:id/publish`, `POST /workflows/validate`
- `POST /workflows/:id/test-step` (run one node with given input, no journaling)
- `POST /workflows/:id/run` (manual trigger)
- `GET  /runs?workflowId&status`, `GET /runs/:id` (run + events + scope), `POST /runs/:id/retry`, `GET /runs/:id/stream` (SSE)
- `POST /hooks/:tenantId/:workflowId/:secret` (inbound webhook; optional HMAC; returns 202 `{ runId }`)
- `POST /resume/:token`

Editor routes go through `authorize`; hooks/resume are authenticated by secret/token.

## 6. Built-in nodes & triggers

| Type | Summary |
|---|---|
| `core.condition` | Rule groups (AND/OR; ops: eq, neq, gt, gte, lt, lte, contains, startsWith, in, isEmpty, isNotEmpty, isTrue, isFalse). Branches `if`, `else`. |
| `core.switch` | `on` value + `cases: {id, label, value}[]`; branches per case + `default`. |
| `core.forEach` | `items` array ref; branch `body`; `loop.item` / `loop.index` in scope. |
| `core.stop` | Completes run with `stoppedAt` and optional reason. |
| `core.delay` | Duration (`"2d"`, `"30m"`) or `until` timestamp. |
| `core.waitForCallback` | Two-phase suspend; `timeoutMs`; optional body schema; branches `resumed`, `timeout`. |
| `core.httpRequest` | method, url, headers, query, body (json/form/text), timeoutMs; sends `Idempotency-Key` header (configurable); SSRF guard blocks private ranges; optional host allowlist. |
| `core.transform` | JS source + declared output fields; runs in `TransformRuntime` with `{ trigger, steps, loop }` read-only; limits: 64MB memory, 1s CPU default. |
| `core.callSubflow` | `workflowId` + input mapping; output = subflow output. |

Triggers: `core.event` (generic by name), `core.webhook` (payload schema declared in config as fields; HMAC secret optional), `core.manual` (input fields), `core.schedule` (cron + tz), `core.subflow` (input/output field declarations). Triggers accept an optional `dedupeKey` ref.

Secrets: `secret()` field marker; editor shows secret names from `GET /secrets` (host-provided list via `secrets.list?`); values resolved only at execution time, never persisted in docs/events.

## 7. Editor (`@flowkit/react`)

### 7.1 Public API

```tsx
const client = createClient({ baseUrl: "/flowkit" });
<FlowkitProvider client={client} theme={{ colorMode: "system", tokens: { accent: "#6d28d9" } }} widgets={{ "crm.entitySelect": EntitySelect }}>
  <WorkflowEditor workflowId="lead-routing" onPublish={...} />
  <RunViewer runId={id} />
  <RunList workflowId="lead-routing" onSelect={...} />
</FlowkitProvider>
```

### 7.2 Layers

1. **Headless**: Zustand store over `WorkflowDoc` with command-based mutations (insert, delete, move, duplicate, update config, rename, toggle disabled) and undo/redo; `layoutTree(doc) → { nodes, edges }` pure function; live validation; data-picker scope computation. Hooks: `useWorkflow`, `useStep`, `useSelection`, `useDataPicker`, `useIssues`, `useRun`.
2. **Default skin**: components below, styled via `--fk-*` CSS custom properties in `@layer flowkit`, built atop `@xyflow/react/dist/base.css`; light/dark via `colorMode`.

### 7.3 Canvas

- Custom deterministic tree layout: fixed card size (260×72), vertical gap 56, branch gap 48; branch blocks centered over their children; explicit rejoin nodes; loop-return edge. Animated position transitions on mutation. Fit-to-view anchors to top.
- No drag-to-connect or free positioning. Pan/zoom/minimap/controls.
- Edge types: `step` (with inline `+`), `branch` (labeled, `+`), `rejoin`, `loopReturn`. Empty branch renders a large "Add step" placeholder node.
- Single **step picker** popover (search + category tabs: Logic, each plugin), used for add/insert/replace; `⌘K` opens it at selection.
- Card: plugin icon, step name, `summary()` line, status badge (invalid, needs-test, tested, disabled), kebab + context menu (Rename, Duplicate, Copy reference, Disable/Enable, Delete, Paste after/inside).
- Keyboard: arrows navigate tree order; ⌘Z/⇧⌘Z; ⌘C/⌘V; Delete/Backspace; Enter opens config; Esc closes. Suppressed in editable targets. xyflow a11y props enabled; ARIA labels localizable.

### 7.4 Config panel

Right side panel; auto-hides on empty selection; pans selected node into view. Form generated from the node's input JSON Schema: string, number, boolean, enum (select), array (repeatable), object (group), plus registered custom widgets. Each field toggles literal ↔ reference. Data picker opens on field focus: typed tree of in-scope upstream outputs (from output schemas; annotated with sample values once tested); inserts pills; text fields mix pills with text and support `{{` autocomplete. Stale refs render as warning pills. "Test step" runs the node via `test-step` with inputs resolved from sample data; resulting output stored as the step's sample (editor-local + saved with the draft); later edits mark `needs-test`.

### 7.5 Header, validation, publishing

Header: workflow name (editable), save state, "N issues" pill cycling through issues (focus + pan), undo/redo, Run now, Publish (disabled while errors exist).

### 7.6 Run viewer

Same canvas, read-only. Cards show status (success/failed/running/waiting/skipped), duration, attempts; untaken paths dimmed. forEach blocks have an iteration stepper, defaulting to the first failed iteration. Selected step shows tabs: Input, Output, Error, Events. Run list sidebar with status filter; Retry from failed step; live updates via SSE.

## 8. Examples

### 8.1 `examples/mini-crm`
Vite + React frontend, Hono backend (Node), memory storage by default, `DATABASE_URL` switches to Postgres. Seeded contacts, deals, users.
- `crm` plugin: nodes Load Contact, Find Contact by Email, Create Contact, Update Deal, Assign Owner, Send Email (mock outbox visible in UI); triggers `contact.created`, `deal.updated`.
- Sub-flows: `getContact`, `createContact`, `getOrCreateContact`.
- Workflows: **Inbound lead routing** (webhook → getOrCreateContact → switch on source → assign owner → condition enterprise → waitForCallback manager approval with an "Approve" button in the UI) and **Deal won follow-up** (deal.updated → condition won / else stop → delay → transform → send email).
- Pages: Contacts, Deals, Workflows (editor), Runs (viewer), Outbox, Webhook tester.

### 8.2 `examples/headless`
~60-line Node script defining nodes + a workflow with the code-first builder and running it in memory, printing the audit log.

## 9. Testing

- core: validator, ref type-checker, interpolation, tree mutations (invariant: always a valid tree), manifest serialization.
- engine: scenario tests on memory adapter incl. crash simulation (kill worker mid-step; assert at-least-once, committed steps never re-run, audit intact); suspend/resume; timeouts; retries; subflows; forEach; stop; dedupe; SSRF guard; transform limits.
- Conformance suite against memory (always) and Postgres (Testcontainers; skipped without Docker).
- react: layout snapshot tests, store/undo tests, a few Testing Library interaction tests.
- Playwright smoke test on mini-crm: add step, map reference, publish, trigger, view run.
- Consumer helpers: `testNode(node, input, ctx?)`, `runWorkflowInMemory(doc, { registry, trigger })`.

## 10. Out of scope for v1 (design leaves room)

Redis adapter; parallel blocks; drag-to-map; OAuth connection management; Temporal/Inngest backend; import/export UI; i18n beyond ARIA labels; references to branch-internal steps after rejoin.
