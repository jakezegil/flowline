# Flowline Triggers & Conditions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five gaps a migrating CRM customer reported: per-match emit failure isolation, time-windowed dedupe with random run IDs, multi-event triggers, strict/loose condition semantics with typed literals and host operators, and a poll trigger kind — with a worked "Deal stuck in stage" example and e2e coverage in mini-crm.

**Architecture:** pnpm monorepo `@flowline/*`: `core` (pure, isomorphic: definitions, doc model, manifest, validator) → `nodes-builtin` → `engine` (durable interpreter over a `StorageAdapter`, workers, HTTP handler, trigger dispatch) → `storage-memory` / `storage-postgres`. `react` consumes only `core` + the JSON manifest. `examples/mini-crm` wires everything together and hosts the Playwright e2e suite.

**Tech Stack:** Node 22, pnpm 10, TypeScript 5.x strict, Zod 4, Vitest 3, tsup, Biome, React 19, @xyflow/react 12, Zustand 5, cron-parser, pg + @electric-sql/pglite (tests), Hono, Vite 6, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-28-flowline-triggers-conditions-design.md` (read it first; section numbers below refer to it). Background: `docs/superpowers/specs/2026-09-27-flowkit-design.md` and `docs/superpowers/plans/2026-09-27-flowkit-v1.md` (v1; pre-rename names).

## Global Constraints

- This plan is executed **after** the flowkit → flowline rename has landed. Every identifier is the post-rename one: package scope `@flowline/*`, `FlowlineValidationError`, `FlowlineDefinitionError`, `FlowlineStorageError`, `FlowlineServices`, `<FlowlineProvider>`, source condition `flowline-source`, signature header `X-Flowline-Signature`, env `FLOWLINE_PG_URL`. Never introduce a `flowkit` identifier.
- All packages ESM-only, `"type": "module"`, TS `strict: true`, `noUncheckedIndexedAccess: true`. Workspace dev resolution: package `exports` resolve to `./src` only under the `flowline-source` condition; every new dev entry point (vitest/vite config, `tsx --conditions=flowline-source`, Playwright webServer) sets it.
- `@flowline/core` and `@flowline/react` must never import from `@flowline/engine`, `nodes-builtin`, Node built-ins, or anything server-only. The browser only ever sees the **manifest** (JSON).
- Timestamps inside engine/storage are epoch milliseconds (`number`). Storage never reads a clock; the engine gets time only from its injectable `clock`.
- Storage adapters: every method is one atomic operation; guarded writes check and write in the same transaction; a write that returns `false`/`null` changes nothing; tenancy on every tenant-scoped method. New methods must be covered by `runStorageConformance` and pass on memory and PGlite.
- Secrets and undredacted payloads never appear in workflow docs, journals, run events or `TriggerEvent`s.
- Breaking changes are allowed (pre-1.0) but every one is listed in spec §11 and reflected in README / plugin guide in the same batch (the docs-check suite typechecks both).
- Every public export has TSDoc. Every new label goes through `labels.ts` (no hard-coded UI strings).
- Commits: conventional commits, end every message with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Work on branch `triggers-conditions`.
- Commands must pass before a task is done: `pnpm -r typecheck`, `pnpm test`, `pnpm lint`; `pnpm build` must still succeed for every package. Task 11 additionally runs the Playwright suite.

## Review Focus

1. **One incompatible trigger among several matches** → the other matches start, the incompatible one is reported in `EmitResult.rejected`, logged, and delivered to `onTriggerEvent` exactly once; `emit` never throws for validation. (Tests in Task 1; poll-item variant in Task 9.)
2. **Exactly-one-run under duplicates, with a TTL** → concurrent deliveries, sender retries and a crash between `claimDedupeKey` and `createRun` all yield one run with the pre-generated random ID; after the window a same-key delivery starts a *new* run even while the first still waits; legacy Postgres rows keep pointing at their derived-ID runs after migration v4. (Tests in Tasks 2, 3.)
3. **Multi-event dedupe across sources** → an AI-call event and a VoIP-call event about the same call, or a booking cancellation and a cancelled-status change about the same booking, start one run under the `event:<wf>:<key>` namespace; `startedBy.event` records the raw source. (Tests in Tasks 4, 11.)
4. **Strict never coerces, loose never regresses** → every row of spec §6.3/§6.4 is pinned in both modes; the host-chosen default reaches the manifest schema default and therefore the editor; a numeric-string literal on a number field under strict raises `rule.literalType`; a custom operator throwing fails the step fatally with its id. (Tests in Tasks 6, 7.)
5. **Poll intervals never overlap or gap** → with two engines ticking, each `(since, until]` interval is claimed by one poller and intervals are contiguous; a failed poll re-covers the same interval; a crash after launching items and before `commitPoll` starts no duplicate item; a deal that moves out of the stage before the threshold never fires; one that moves while the run waits is cancelled with reason "Stage changed". (Tests in Tasks 8, 9, 11.)

Also exercised: `window` of `0` rejected; item with empty key rejected; `normalize` returning `undefined` skips silently; trigger kind `poll` in every exhaustive `switch`.

## Directions → tasks

| Direction | Tasks |
|---|---|
| 1 Emit failure isolation | 1 |
| 2 Time-windowed dedupe | 2 (storage), 3 (engine + core + handler) |
| 3 Multi-event triggers | 4 (core + engine), 5 (react) |
| 4 Condition semantics | 6 (nodes-builtin + core meta), 7 (react) |
| 5 Poll trigger kind | 8 (storage), 9 (core + engine), 10 (react) |
| e2e + docs | 11 (mini-crm demos + Playwright), 12 (README, guides, docs-check) |

Tasks are sequential (each builds on the previous), except 5 ∥ 6 and 7 ∥ 8 may run in parallel.

## File structure (new or changed)

```
packages/
  core/src/
    types.ts                 DurationInput, TriggerKind "poll", TriggerManifest.events/interval, UiMeta.operators, RuleOperatorMeta, RuleValueType
    define.ts                TriggerDefinition: events, normalize, dedupe, poll, interval, PollArgs/PollResult/PollItem/PollContext; defineTrigger checks
    api-types.ts             RunOrigin poll variant
    registry.ts              manifest: events, interval
  nodes-builtin/src/
    rules.ts                 CompareMode, ConditionRules, strictEquals, CustomOperator, EvaluateOptions, strictly/loosely/custom
    logic.ts                 condition/switch compare; createConditionNode/createSwitchNode factories
    builtin-plugin.ts        createBuiltinPlugin, BuiltinOptions (index.ts re-exports; builtinPlugin = createBuiltinPlugin())
    triggers.ts              core.webhook dedupeWindow
  engine/src/
    storage.ts               DedupeClaim, claimDedupeKey, PollState, PollLease, PollPatch, claimPoll, renewPollLease, commitPoll, getPollState
    triggers.ts              EmitResult, EmitRejection, DedupeOptions, launch protocol, multi-event matching, tickPolls
    trigger-events.ts        TriggerEvent union + publishTriggerEvent
    engine.ts                EngineOptions.onTriggerEvent/dedupe/poll; Engine.tickPolls
    worker.ts                pollEveryMs
    handler.ts               POST /workflows/:id/run dedupe body
    duration.ts              parseWindow (wraps parseDuration; >= 1 ms, <= MAX_DURATION_MS)
    testing/conformance.ts   dedupe + polls suites
  storage-memory/src/index.ts
  storage-postgres/src/{schema.ts (v4), index.ts}
  react/src/
    labels.ts                new labels
    canvas/trigger-card.tsx  multi-event + poll captions
    panel/trigger-config.tsx event list, poll hint
    panel/widgets/rules.tsx  compare, typed literals, custom operators
    panel/widgets/cases.tsx  compare, typed case values
    run/{run-list.tsx, run-viewer.tsx}  poll origin (via labels.origin)
examples/mini-crm/
  server/src/crm-store.ts   calls, stageEnteredAt, ai_call.ended / voip_call.ended events
  server/src/plugin/{triggers.ts (callEnded, dealStuckInStage), deals.ts (getDeal), users.ts (getUser)}
  server/src/flows/{any-call-ended.ts, deal-stuck.ts}
  server/src/app.ts         emit result logging, stage-change cancellation, fake clock + /api/demo/advance, /api/calls
  web/src/pages/contacts.tsx  Log AI call / Log VoIP call
  e2e/triggers.spec.ts
README.md, docs/guides/writing-a-plugin.md, examples/mini-crm/README.md
```

---

### Task 1: engine — emit failure isolation and trigger events

**Files:** `packages/engine/src/{triggers.ts, trigger-events.ts, engine.ts, index.ts}`; tests `triggers.test.ts` (extend), `trigger-events.test.ts`. `examples/mini-crm/server/src/app.ts` (adapt the `emit` call site so the workspace typechecks).

**Interfaces**

Consumes: `checkTriggerPayload`, `visibleTriggerConfig` (subflow.ts), `EngineCore.logger`, `Issue` from `@flowline/core`.

Produces (exported from `@flowline/engine`):
```ts
export interface EmitRejection { workflowId: string; version: number; message: string; issues: Issue[] }
export interface EmitResult { started: string[]; rejected: EmitRejection[] }
export type TriggerEvent = /* the union in spec §3.3: trigger.rejected | trigger.deduped | poll.completed | poll.failed */;
interface EngineOptions { onTriggerEvent?: (e: TriggerEvent) => void }
interface Engine { emit(event: string, payload: unknown, opts: { tenantId: string; dedupeKey?: string }): Promise<EmitResult> }  // dedupeKey renamed in Task 3
// trigger-events.ts (internal)
export function publishTriggerEvent(core: EngineCore, e: TriggerEvent): void;   // calls onTriggerEvent inside try/catch, logs rejected/failed at warn
```
`EngineCore` gains `triggerEvent(e: TriggerEvent): void`.

**Tests must pin**
- Three published workflows match one event; one trigger's payload schema rejects → `started` has two IDs (workflow ID order), `rejected` has one entry with `workflowId`, `version`, a message naming the field, and `issues[0].code === "config.invalid"`; `onTriggerEvent` received exactly one `trigger.rejected` with `source: { kind: "event", event }` and no payload field; the logger got one `warn`.
- `filter` throwing → rejected with `message` starting `filter threw:`; `filter` returning `false` → neither started nor rejected.
- `dedupeKey` throwing → rejected; other matches unaffected.
- Zero matches → `{ started: [], rejected: [] }`.
- `onTriggerEvent` throwing is logged and does not fail `emit`.
- `start` with invalid input still throws `FlowlineValidationError`; webhook invalid body still returns `{ status: "invalid" }` (regression guard).

- [ ] **Step 1:** Write the failing tests above in `triggers.test.ts` / `trigger-events.test.ts`.
- [ ] **Step 2:** Implement `trigger-events.ts`, thread `onTriggerEvent` through `createEngine`, restructure `emit` into per-match `try/catch` producing `EmitRejection`s; update TSDoc on `Engine.emit`.
- [ ] **Step 3:** Update `examples/mini-crm/server/src/app.ts` to read `result.rejected` and log each entry (`logger.warn("workflow rejected CRM event", …)`).
- [ ] **Step 4:** `pnpm -r typecheck && pnpm test && pnpm lint`. Commit `feat(engine): isolate emit failures per match and report trigger events`.

---

### Task 2: storage — `claimDedupeKey`, migration v4 (dedupe part), conformance

**Files:** `packages/engine/src/storage.ts`, `packages/engine/src/testing/conformance.ts`, `packages/storage-memory/src/index.ts`, `packages/storage-postgres/src/{schema.ts, index.ts}`; tests `memory.test.ts`, `postgres.test.ts` (extend). Temporarily, `packages/engine/src/triggers.ts` `launch` is switched to the new method with the *old* derived-ID behaviour removed (Task 3 finishes the protocol) — keep the engine compiling by generating a random ID and calling `claimDedupeKey`; the full precedence/window work lands in Task 3.

**Interfaces**

Consumes: `StorageAdapter` general rules (atomicity, tenancy).

Produces:
```ts
export interface DedupeClaim { runId: string; claimed: boolean }
interface StorageAdapter {
  claimDedupeKey(tenantId: string, key: string, runId: string, now: number, windowMs: number): Promise<DedupeClaim>;
  // recordDedupeKey removed
}
// schema.ts
{ version: 4, statements: v4(s) }   // ALTER dedupe_keys ADD run_id; backfill via sha256(); SET NOT NULL  (poll_states table added in Task 8's v4 extension — see note)
```
Note: v4 is authored once. Task 2 creates `v4()` with the dedupe statements; Task 8 appends the `poll_states` statements to the same `v4()` (the migration has not shipped between tasks). Both parts are `IF NOT EXISTS`/idempotent.

**Tests must pin** (conformance, both adapters)
- `claimDedupeKey(T1, "k", "run_a", 1000, 500)` → `{ runId: "run_a", claimed: true }`; `(…, "run_b", 1200, 500)` → `{ runId: "run_a", claimed: false }`; at `1500` (== expiry) → `{ runId: "run_c", claimed: true }`.
- Ten concurrent claims with distinct IDs → exactly one `claimed: true`; all ten `runId`s equal.
- Same key, other tenant → independent.
- A losing claim does not change the stored expiry (claim at 1400 with window 10 000, then claim at 1500 still wins with a new ID).
- Postgres only: insert a v3-shaped row (`run_id` NULL) before `migrate()`; after migrate, `claimDedupeKey` on that unexpired key returns `claimed: false` with `runId === "run_" + sha256Hex("<tenant>\0<key>").slice(0, 32)` (computed with `node:crypto` in the test).

- [ ] **Step 1:** Add the conformance cases; run against memory and PGlite → FAIL.
- [ ] **Step 2:** Implement memory and Postgres adapters; write `v4()`; update the `StorageAdapter` TSDoc.
- [ ] **Step 3:** Minimal engine switch (see Files note); `pnpm -r typecheck && pnpm test && pnpm lint`.
- [ ] **Step 4:** Commit `feat(storage): atomic claimDedupeKey with run id and ttl; schema v4`.

---

### Task 3: core + engine — random run IDs, dedupe windows, `dedupe` options

**Files:** `packages/core/src/{types.ts (DurationInput), define.ts (TriggerDedupe, dedupe)}`, `packages/engine/src/{duration.ts, triggers.ts, engine.ts, handler.ts, index.ts}`, `packages/nodes-builtin/src/triggers.ts` (webhook `dedupeWindow`); tests `engine/src/{triggers.test.ts, schedule.test.ts, handler.test.ts, duration.test.ts}`, `core/src/define.test.ts`, `nodes-builtin/src/index.test.ts`. Call sites: `examples/mini-crm/server/src/app.ts`, `examples/headless/src/main.ts` if it uses `dedupeKey`, README snippets (docs-check will fail until Task 12 — acceptable only if Task 12 lands in the same PR; otherwise update the README `emit`/`dedupe` snippet here).

**Interfaces**

Consumes: `claimDedupeKey` (Task 2), `parseDuration`, `MAX_DURATION_MS` from `@flowline/nodes-builtin`.

Produces:
```ts
// @flowline/core
export type DurationInput = number | string;
export interface TriggerDedupe<C extends z.ZodObject, P> { key(args: { config: z.infer<C>; payload: P; event?: string }): string | undefined; window?: DurationInput }
interface TriggerDefinition<C, P> { dedupe?: TriggerDedupe<C, P> }   // dedupeKey removed; defineTrigger validates window >= 1 ms
// @flowline/engine
export interface DedupeOptions { key?: string; window?: DurationInput }
interface EngineOptions { dedupe?: { defaultWindow?: DurationInput } }   // default "7d"
interface Engine {
  emit(event: string, payload: unknown, opts: { tenantId: string; dedupe?: DedupeOptions }): Promise<EmitResult>;
  start(opts: { tenantId: string; workflowId: string; input?: unknown; dedupe?: DedupeOptions; startedBy?: RunOrigin }): Promise<string>;
}
// duration.ts (internal)
export function parseWindow(input: DurationInput | undefined, fallbackMs: number): number;  // throws FlowlineValidationError for < 1 ms, > MAX_DURATION_MS, unparsable
// core.webhook config
dedupeWindow?: string   // duration text, validated with parseDuration; used for dedupeHeader keys
```
Launch protocol per spec §4.2; namespaces per §4.3; precedence per §4.4. `POST /workflows/:id/run` body gains `dedupe?: { key?, window? }`.

**Tests must pin**
- Run IDs match `/^run_[0-9a-f]{32}$/` and differ for two runs with different keys; the same key twice within the window → same ID, second call `created: false`, one `trigger.deduped` event.
- Crash between claim and create (`__testHooks.beforeCommit` is for run commits; add a test-only `__testHooks.afterDedupeClaim` that throws once) → retry creates the run with the claimed ID; `run.started` published once in total.
- Ten concurrent `emit`s with one key → one run; all return the same ID (nine via `deduped`).
- Window expiry while active: emit with `window: "1m"`, advance the fake clock 61 s while the run is `waiting` on a delay → second emit starts a second run with a different ID; first run untouched.
- Precedence: trigger `dedupe.key` beats `opts.dedupe.key`; a trigger without `dedupe` uses `opts.dedupe.key`; webhook header beats trigger key.
- Window precedence: call → trigger → engine default; `window: 0`, `"-1s"`, `"nope"` → `FlowlineValidationError` (call) / `FlowlineDefinitionError` (definition).
- Schedule dedupe still guards concurrent ticks (`schedule.test.ts` unchanged expectations).
- Handler: `POST /workflows/:id/run` twice with `dedupe: { key: "x" }` → same `runId`.

- [ ] **Step 1:** Failing tests. **Step 2:** Implement core types + `defineTrigger` checks, `duration.ts`, launch protocol, call-site rename (`dedupeKey` → `dedupe`), webhook window, handler body, engine option and TSDoc.
- [ ] **Step 3:** Update mini-crm/headless call sites. `pnpm -r typecheck && pnpm test && pnpm lint`.
- [ ] **Step 4:** Commit `feat(engine): random run ids and time-windowed dedupe`.

---

### Task 4: core + engine — multi-event triggers

**Files:** `packages/core/src/{define.ts, types.ts, registry.ts}`, `packages/engine/src/triggers.ts`; tests `core/src/{define.test.ts, registry.test.ts}`, `engine/src/triggers.test.ts`.

**Interfaces**

Consumes: Task 1 isolation loop, Task 3 dedupe namespace `event:<wf>:<key>`.

Produces:
```ts
// @flowline/core
interface TriggerDefinition<C, P> {
  events?: readonly string[];
  normalize?(event: string, payload: unknown): P | undefined;
  filter?(args: { config: z.infer<C>; payload: P; event?: string }): boolean;
}
interface TriggerManifest { events?: string[] }
// defineTrigger throws FlowlineDefinitionError: event+events; empty/duplicate events; events without normalize; events/normalize on non-event kind
```
Engine matching: `def.event === event || def.events?.includes(event) || (core.event && config.event === event)`; pipeline order normalize → validate → filter → key (spec §3.2); `startedBy.event` is the raw event.

**Tests must pin**
- `defineTrigger` matrix (each invalid combination throws with a message naming the trigger type; valid single- and multi-event definitions pass).
- Manifest carries `events` for multi, `event` for single, neither for `core.event`.
- Emitting each of two listed events starts the same workflow once each; `startedBy.event` differs; the run's `trigger` is the normalized payload.
- `normalize` returning `undefined` → skip (not rejected); throwing → rejected; returning a payload that fails the schema → rejected with the field name.
- Cross-source dedupe: `dedupe.key` returning the same ID for both events → one run, one `trigger.deduped`.
- `dedupe.key` receives `event`; `filter` receives `event`.

- [ ] **Step 1:** Failing tests. **Step 2:** Implement. **Step 3:** Commit `feat(core,engine): multi-event triggers with normalize`.

---

### Task 5: react — multi-event trigger UI

**Files:** `packages/react/src/{labels.ts, canvas/trigger-card.tsx, panel/trigger-config.tsx}`; tests `canvas/canvas.test.tsx` (trigger card cases), `panel/trigger-config.test.tsx` (new), `labels.test.ts`.

**Interfaces**

Consumes: `TriggerManifest.events` (Task 4).

Produces (labels):
```ts
triggerEvents(events: string[]): string;      // "When any of: a, b, c" / "+N more" past three
triggerEventsHint(events: string[]): string;  // config callout: lists events, says payloads are normalized
```
`TriggerTypeSelect` options get secondary text (`event` or joined `events`) via `<optgroup>`/option labels (options cannot carry rich content; use `"Any call ended — ai_call.ended, voip_call.ended"` truncated).

**Tests must pin**
- Trigger card caption for `events: ["a","b"]` is `labels.triggerEvents(["a","b"])`; for four events shows three and "+1 more".
- Config panel shows the multi-event callout and not the single-event hint; single-event unchanged.
- The type select option text includes the event names.

- [ ] **Step 1:** Failing tests. **Step 2:** Implement. **Step 3:** Commit `feat(react): show multi-event triggers in picker, card and config`.

---

### Task 6: nodes-builtin + core — compare modes, custom operators, `createBuiltinPlugin`

**Files:** `packages/core/src/types.ts` (`RuleValueType`, `RuleOperatorMeta`, `UiMeta.operators`), `packages/core/src/ui.ts` (accept `operators`), `packages/nodes-builtin/src/{rules.ts, logic.ts, builtin-plugin.ts, index.ts}`, `packages/engine/src/engine.ts` (`withBuiltins` unchanged in behaviour; TSDoc mentions `createBuiltinPlugin`); tests `nodes-builtin/src/{rules.test.ts, rules-strict.test.ts, logic.test.ts, builtin-plugin.test.ts}`, `core/src/{ui.test.ts or define.test.ts}`, `engine/src/builtins.test.ts`.

**Interfaces**

Consumes: `ui()` metadata, `defineNode`, `definePlugin`.

Produces:
```ts
// @flowline/core
export type RuleValueType = "string" | "date" | "number" | "boolean" | "array" | "object" | "any";
export interface RuleOperatorMeta { id: string; label: string; arity: "unary" | "binary"; types?: RuleValueType[] }
interface UiMeta { operators?: RuleOperatorMeta[] }
// @flowline/nodes-builtin
export type CompareMode = "strict" | "loose";
export interface ConditionRules extends RuleGroup { compare?: CompareMode }
export interface CustomOperator { id: string; label: string; arity: "unary" | "binary"; types?: RuleValueType[]; evaluate(left: unknown, right: unknown, ctx: { compare: CompareMode }): boolean }
export interface EvaluateOptions { compare?: CompareMode; operators?: Readonly<Record<string, CustomOperator>> }
export function evaluateRules(g: RuleGroup | ConditionRules, opts?: EvaluateOptions): boolean;
export function strictEquals(a: unknown, b: unknown): boolean;
export function strictly(group: RuleGroup): ConditionRules;
export function loosely(group: RuleGroup): ConditionRules;
export function custom(op: string, left: unknown, right?: unknown): Rule;
export interface BuiltinOptions { compare?: CompareMode; operators?: CustomOperator[] }
export function createBuiltinPlugin(opts?: BuiltinOptions): PluginDefinition;
export const builtinPlugin: PluginDefinition;   // createBuiltinPlugin()
export function createConditionRulesSchema(opts: { defaultCompare: CompareMode; operators: CustomOperator[] }): z.ZodType<ConditionRules>;  // op enum extended; ui({ enumLabels, operators }); compare default
// core.switch input: compare?: CompareMode (default from options)
```
`conditionNode`/`switchNode` remain exported as the loose, operator-free instances; `createBuiltinPlugin` builds fresh node instances via internal factories `createConditionNode(opts)` / `createSwitchNode(opts)`.

**Tests must pin**
- Every row of spec §6.3 and §6.4 in both modes (table-driven test; each cell is one assertion with the row text as the test name).
- Strict unset handling: `eq(null,null)` true, `eq(null,undefined)` false, `gt(null,0)` false, `contains(undefined,"a")` false; `neq` is `!eq` in both modes.
- `caseSensitive` ignored under strict (`eq("Won","won")` false either way).
- `createBuiltinPlugin({ compare: "strict" })` → manifest `core.condition` input schema `rules.properties.compare.default === "strict"` and switch `compare.default === "strict"`; a doc without `compare` evaluates strictly; a doc with `compare: "loose"` evaluates loosely under that plugin.
- Custom operator: offered in the manifest `op.enum`, `enumLabels` and `ui.operators`; unary evaluates with `right === undefined`; binary gets `right`; throwing → `FatalError` whose message contains the operator id; duplicate/builtin id → `FlowlineDefinitionError`.
- Helpers `strictly`/`loosely`/`custom` produce the expected shapes and round-trip through the schema.
- `createEngine` with a registry that already contains `createBuiltinPlugin({ compare: "strict" })` does not prepend a second `core` plugin.

- [ ] **Step 1:** Failing tests. **Step 2:** Implement `strictEquals`, strict paths in `evaluateRule`, operator registry, schema factory, plugin factory, switch `compare`.
- [ ] **Step 3:** Commit `feat(nodes-builtin): strict compare mode, custom operators and createBuiltinPlugin`.

---

### Task 7: react — rules and cases widgets

**Files:** `packages/react/src/{labels.ts, panel/widgets/rules.tsx, panel/widgets/cases.tsx, panel/widgets/literal.ts (new: typed-literal parsing/formatting), panel/widgets/widgets.test.tsx}`.

**Interfaces**

Consumes: manifest `op.enum`, `ui.enumLabels`, `ui.operators`, `rules.properties.compare.default`, `valueTypeOf`.

Produces:
```ts
// literal.ts
export function toTypedLiteral(text: string, type: ValueType): Literal;             // "5" → 5 for number; "true" → true for boolean; else text
export function toTypedList(text: string, type: ValueType): Literal[];               // "5, 7" → [5, 7]
export function literalTypeIssue(rule: Rule, leftType: ValueType, compare: CompareMode): Issue | undefined;  // code "rule.literalType", severity "warning"
// labels
compare: string; compareStrict: string; compareLoose: string; compareStrictHint: string; compareLooseHint: string;
literalTypeWarning(leftType: string): string;
```
Widget behaviour per spec §6.5/§6.8: Compare select on the top-level group (and on the switch cases widget), Match case hidden under strict, typed right-hand controls, `in` tag list storing typed arrays, custom operators merged into `OPS_BY_TYPE`/`UNARY` with labels from `enumLabels`, and `rule.literalType` rendered as an issue note.

**Tests must pin**
- Left `trigger.deal.amount` (number in scope): typing `5` stores `right: 5`; typing `abc` keeps `"abc"` and shows the `rule.literalType` warning only when compare is strict.
- Left boolean: a select stores `true`/`false`.
- Op `in` with number left: `"5, 7"` → `[5, 7]`; with string left → `["a", "b"]`.
- Compare select defaults to the schema default (`strict` when the manifest says so); switching to strict hides Match case and strips `caseSensitive` from rules.
- A custom unary operator with `types: ["string"]` appears for string lefts, not for number lefts, with its `enumLabels` label; selecting it removes `right`.
- Cases widget: Compare select present; case values typed by the switch `value` operand type.
- Existing docs with string literals render unchanged under loose (snapshot).

- [ ] **Step 1:** Failing tests. **Step 2:** Implement. **Step 3:** Commit `feat(react): compare mode, typed literals and custom operators in the rules widget`.

---

### Task 8: storage — poll state, conformance, migration v4 (poll part)

**Files:** `packages/engine/src/storage.ts`, `packages/engine/src/testing/conformance.ts`, `packages/storage-memory/src/index.ts`, `packages/storage-postgres/src/{schema.ts, index.ts}`; tests `memory.test.ts`, `postgres.test.ts`.

**Interfaces**

Consumes: lease pattern of `claimRun`/`renewLease`/`commit`.

Produces:
```ts
export interface PollState { tenantId: string; workflowId: string; since: number | null; cursor: unknown; nextAt: number; lastError?: string; leaseOwner?: string; leaseUntil?: number; updatedAt: number }
export interface PollLease { state: PollState; token: string }
export interface PollPatch { since?: number; cursor?: unknown; nextAt: number; lastError?: string | null }
interface StorageAdapter {
  claimPoll(tenantId: string, workflowId: string, opts: { workerId: string; leaseMs: number; now: number }): Promise<PollLease | null>;
  renewPollLease(lease: PollLease, leaseMs: number, now: number): Promise<boolean>;
  commitPoll(lease: PollLease, patch: PollPatch, now: number): Promise<boolean>;
  getPollState(tenantId: string, workflowId: string): Promise<PollState | null>;
}
// schema.ts v4(): + poll_states table and next_at index (spec §7.3)
```

**Tests must pin** — every bullet of spec §7.4, on both adapters; plus Postgres: `cursor` stored as jsonb round-trips `{ a: [1, null] }`; `commitPoll` with a non-JSON cursor (a `BigInt`) rejects with `FlowlineStorageError` and changes nothing.

- [ ] **Step 1:** Conformance cases → FAIL. **Step 2:** Implement both adapters, extend `v4()`. **Step 3:** Commit `feat(storage): poll state with leases; schema v4 poll_states`.

---

### Task 9: core + engine — poll trigger kind and `tickPolls`

**Files:** `packages/core/src/{types.ts, define.ts, api-types.ts, registry.ts}`, `packages/engine/src/{triggers.ts, engine.ts, worker.ts, index.ts}`; tests `core/src/{define.test.ts, registry.test.ts}`, `engine/src/{polls.test.ts (new), worker.test.ts or schedule.test.ts}`.

**Interfaces**

Consumes: Task 8 storage methods; Task 3 `launch` with `{ key: "poll:<wf>:<itemKey>", windowMs }`; Task 1 `publishTriggerEvent`.

Produces:
```ts
// @flowline/core
export type TriggerKind = "event" | "webhook" | "manual" | "schedule" | "subflow" | "poll";
export interface PollItem<P> { key: string; payload: P }
export interface PollResult<P> { items: PollItem<P>[]; cursor?: unknown }
export interface PollContext { tenantId: string; workflowId: string; services: FlowlineServices; logger?: Logger; signal: AbortSignal }
export interface PollArgs<C> { config: C; since: number; until: number; cursor: unknown; ctx: PollContext }
interface TriggerDefinition<C, P> { poll?(args: PollArgs<z.infer<C>>): Promise<PollResult<P>> | PollResult<P>; interval?: DurationInput }
interface TriggerManifest { interval?: number }
export type RunOrigin = /* existing variants */ | { kind: "poll"; since: number; until: number; itemKey: string };
// @flowline/engine
interface EngineOptions { poll?: { defaultInterval?: DurationInput /* "1m" */; leaseMs?: number /* 60_000 */ } }
interface Engine { tickPolls(): Promise<number> }
interface WorkerOptions { pollEveryMs?: number /* 15_000 */ }
```
Loop per spec §7.2; lease renewal every `leaseMs / 2`; `ctx.signal` aborted on renewal failure.

**Tests must pin**
- `defineTrigger`: `kind: "poll"` without `poll` throws; `poll`/`interval` on `event` throws; manifest `interval` is ms.
- First tick after publish: `since === publishedAt`, `until === now`; state after: `since === until`, `nextAt === until + interval`; `poll.completed` event with counts.
- Not due (`nextAt > now`) → poll not called; due at `nextAt === now` → called.
- Two engines (shared memory storage) ticking concurrently → `poll` called once; intervals over five ticks are contiguous (`since_n === until_{n-1}`).
- Poll throws → `since`/`cursor` unchanged, `nextAt === now + interval`, `lastError` set, `poll.failed` published, `warn` logged; next tick re-covers the same `since`.
- Items: each starts a run with `startedBy: { kind: "poll", since, until, itemKey }` and `trigger === payload`; invalid item → `trigger.rejected` with `source.kind === "poll"` and the rest start; duplicate keys within one result → one run; empty key → rejected.
- Crash after launching the first item and before `commitPoll` (test hook `__testHooks.beforeCommitPoll`) → next tick re-polls the same interval and starts only the unstarted items.
- Lease lost during a slow poll (`renewPollLease` forced false) → `ctx.signal.aborted`, `commitPoll` false, nothing started by this holder.
- Worker: `pollEveryMs` ticks polls on the first loop only; `stop()` awaits an in-flight tick.
- `until <= since` (clock stepped back) → no `poll` call; `nextAt === since + interval`.

- [ ] **Step 1:** Failing tests. **Step 2:** Implement core types/checks, manifest, `tickPolls`, worker option, engine options, TSDoc. **Step 3:** Commit `feat(engine): poll trigger kind driven over bounded, non-overlapping intervals`.

---

### Task 10: react — poll trigger presentation

**Files:** `packages/react/src/{labels.ts, canvas/trigger-card.tsx, panel/trigger-config.tsx, run/run-list.tsx, run/run-viewer.tsx}`; tests `canvas/canvas.test.tsx`, `panel/trigger-config.test.tsx`, `run/run-list.test.tsx`, `labels.test.ts`.

**Interfaces**

Consumes: `TriggerManifest.kind === "poll"`, `interval`; `RunOrigin` poll variant.

Produces (labels): `triggerPoll(intervalMs: number): string` ("Checks every 5 minutes"), `originPoll(itemKey: string): string`; `labels.origin` handles `{ kind: "poll" }`.

**Tests must pin**
- Trigger card caption for a poll trigger with `interval: 300_000` → `labels.triggerPoll(300_000)`; every `switch (t.kind)` has a `poll` case (typecheck with `satisfies never` guard).
- Config panel shows the poll hint and the config form; no webhook URL / event callout.
- Run list origin cell for a poll run renders `labels.originPoll(itemKey)`.

- [ ] **Step 1:** Failing tests. **Step 2:** Implement. **Step 3:** Commit `feat(react): poll trigger captions and run origin`.

---

### Task 11: mini-crm — "Any call ended" and "Deal stuck in stage" demos, host cancellation, e2e

**Files:** `examples/mini-crm/server/src/{crm-store.ts, app.ts, index.ts, plugin/{triggers.ts, deals.ts, users.ts, index.ts}, flows/{any-call-ended.ts, deal-stuck.ts, index.ts, names.ts}}`, `examples/mini-crm/web/src/{api.ts, pages/contacts.tsx, pages/deals.tsx}`, `examples/mini-crm/e2e/{triggers.spec.ts (new), playwright.config.ts}`; tests `server/src/app.test.ts`, `web/src/pages.test.tsx`.

**Interfaces**

Consumes: everything above.

Produces:
```ts
// crm-store.ts
export type CallKind = "ai" | "voip";
export interface Call { id: string; contactId: string; kind: CallKind; durationSec: number; endedAt: string; summary?: string }
export type CrmEvent = /* existing variants */ | { id: string; type: "ai_call.ended"; payload: { call: { id; contactId; seconds; endedAt; transcriptSummary } } }
                        | { id: string; type: "voip_call.ended"; payload: { callId; contactId; durationMs; endedAt } };
DealSchema: + stageEnteredAt: z.iso.datetime()   // set at seed and on every stage change
CrmStore: logCall(input: { id?: string; contactId: string; kind: CallKind; durationSec: number; summary?: string }): Promise<Call>; listCalls(contactId?: string): Call[]
// plugin
export const callEnded      // spec §5.4
export const dealStuckInStage   // spec §7.5 (interval "10s")
export const getDeal        // crm.getDeal { dealId } → { deal }
export const getUser        // crm.getUser { userId } → { user }
// flows
export const anyCallEndedFlow: WorkflowDoc     // callEnded { minSeconds: 30 } → getContact → getUser(owner) → condition strict: contact.ownerId isNotEmpty → sendEmail to owner "Call with {{trigger.call.source}}…"; else stop "No owner"
export const dealStuckFlow: WorkflowDoc        // spec §7.5, compare strict, delay "1m"
// app.ts
POST /api/calls { id?, contactId, kind, durationSec, summary? } → 201 Call   // same id twice: 200 with the existing call and the event re-emitted (simulates redelivery)
POST /api/demo/advance { ms } → 204   // only when MINI_CRM_FAKE_CLOCK=1; index.ts builds a fake clock (start = real now, offset advanced by the route)
crm.onEvent: on deal.updated with changes ∋ "stage" → cancel waiting/queued runs of "deal-stuck-in-stage" whose trigger.deal.id matches, reason "Stage changed"
engine created with createRegistry([createBuiltinPlugin({ compare: "strict", operators: [isUnassigned] }), crmPlugin]) — isUnassigned lives in server/src/operators.ts; the strict default is deliberate: it shows a host default and the seeded flows already use typed literals and onTriggerEvent → logger + an in-memory ring buffer exposed at GET /api/demo/trigger-events (last 100; for e2e assertions)
```
Web: Contacts page gets "Log AI call" / "Log VoIP call" buttons on a contact row (posting to `/api/calls`); Deals page shows `stageEnteredAt` as "in stage since". Playwright `webServer` sets `MINI_CRM_FAKE_CLOCK=1`.

**Tests must pin**
- `app.test.ts`: logging an AI call and a VoIP call starts two `any-call-ended` runs with `startedBy.event` `ai_call.ended` / `voip_call.ended`; posting the same call id twice → one run and one `trigger.deduped` in `/api/demo/trigger-events`; a 10-second call starts no run (`minSeconds`); the stuck-deal poll after `advance(3d + 10s)` starts exactly one run per proposal deal seeded, none for deals that moved to `qualified` before advancing; advancing another 3 days starts nothing new for the same stint; moving a deal back into `proposal` and advancing 3 days starts a new run.
- `app.test.ts`: while the stuck-deal run waits on `delay`, `PATCH /api/deals/:id { stage: "won" }` → run `cancelled` with `cancelRequest.reason === "Stage changed"`; a run whose deal moved during the wait but was *not* cancelled (host hook disabled via option) stops at `recheck` with "Deal moved on".
- `e2e/triggers.spec.ts`:
  1. "Any call ended: AI and VoIP calls each start a run, a redelivered call does not" — log both calls from the Contacts page, open Runs, expect two runs of "Any call ended" with different origins, log the AI call again with the same id, expect still two runs.
  2. "Deal stuck in stage: the sweep nudges the owner, and changing the stage cancels the waiting run" — advance the clock 3 days via the API, expect a run of "Deal stuck in stage" whose outbox email names the deal, change the deal's stage on the Deals page, expect the run viewer to show Cancelled with reason "Stage changed".
  3. "Deal stuck in stage: a deal that moved on before the threshold never fires" — move a seeded proposal deal to `qualified`, advance 3 days, expect no run for it.
- `pages.test.tsx`: the call buttons post the right payloads.

- [ ] **Step 1:** Failing server tests, then web tests, then e2e specs.
- [ ] **Step 2:** Implement store, plugin, flows, routes, fake clock, cancellation hook, web buttons.
- [ ] **Step 3:** `pnpm -r typecheck && pnpm test && pnpm lint`, then `pnpm --filter mini-crm e2e`.
- [ ] **Step 4:** Commit `feat(mini-crm): any-call-ended and deal-stuck-in-stage demos with e2e coverage`.

---

### Task 12: docs — README, plugin guide, mini-crm README, docs-check

**Files:** `README.md` (Triggers section: `emit` result, `dedupe`, windows; new "Multi-event triggers", "Poll triggers", "Condition semantics" subsections; Roadmap), `docs/guides/writing-a-plugin.md` (`events`/`normalize`, `dedupe`, `kind: "poll"`, `createBuiltinPlugin` with a custom operator), `examples/mini-crm/README.md` (new demo workflows, `/api/calls`, `/api/demo/advance`, fake clock), `examples/docs-check/stubs/*` if a new stub is needed for the snippets.

**Interfaces**

Consumes: all public APIs above. Produces: no code; every TypeScript block in the docs typechecks under the docs-check suite.

**Tests must pin**
- `examples/docs-check` passes: all blocks annotated and typechecked; the README quick start still runs end to end.
- The README dedupe paragraph no longer claims keys are permanent; it states the default window and the expiry rule (spec §4.5).

- [ ] **Step 1:** Update the docs. **Step 2:** `pnpm test` (docs-check included), `pnpm lint`. **Step 3:** Commit `docs: triggers, dedupe windows, condition semantics and poll triggers`.

---

## Done when

- Every Review Focus item has a green test naming it.
- `pnpm -r typecheck`, `pnpm test`, `pnpm lint`, `pnpm build` and the mini-crm Playwright suite pass on `triggers-conditions`.
- Spec §11 lists every breaking change shipped, and the README/guide reflect each.
