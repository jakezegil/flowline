# Flowline — Triggers & Conditions Design Spec

**Date:** 2026-09-28
**Status:** Design directions approved; this written spec is pending review
**Extends:** `docs/superpowers/specs/2026-09-27-flowkit-design.md` (the v1 spec; package scope is now `@flowlinejs/*`)
**Applies after:** the flowkit → flowline rename. All names below are post-rename (`FlowlineValidationError`, `@flowlinejs/engine`, …).

## 1. Purpose

A CRM customer migrating their automations onto the library reported five gaps between their compiler/middleware and the built-ins. Each maps to one approved design direction:

| # | Feedback | Direction |
|---|---|---|
| 1 | One workflow with an incompatible trigger payload schema rejects the whole emission before valid matches start. | **Emit failure isolation**: validate per match; report rejections; start the rest. |
| 2 | The library derives run IDs from dedupe keys, so dedup is effectively permanent; reusing a booking ID as a key suppresses a later legitimate event. Their middleware uses time-limited keys. | **Time-windowed dedupe**: keys carry a TTL, run IDs are random, and the key stores the pre-generated run ID. |
| 3 | Automations subscribe to several events ("Any call ended" = AI + VoIP; "Combined booking cancellation" = booking cancellation + appointment status) with logic to avoid double firing. Triggers match one event name. | **Multi-event triggers**: `events: [...]` + `normalize`, with a per-workflow dedupe namespace. |
| 4 | Their compiler uses strict equality, explicit numeric conversion, array membership and special handling for unassigned values; the built-ins compare loosely and fold case by default, and "Match case" doesn't restore type equality. | **Condition semantics**: a `compare: "strict" \| "loose"` mode per rule set, typed literals in the editor, host-registered operators (`isUnassigned`), host-chosen default. |
| 5 | Time-in-stage is a domain sweep over a bounded interval; a cron or "wait N days" changes behaviour unless stage transitions, eligibility and cancellation are handled deliberately. | **Poll trigger kind**: `kind: "poll"` driven over non-overlapping bounded intervals with a stored cursor, one run per item with a per-item dedupe key, plus a worked "Deal stuck in stage" example. |

Breaking changes are acceptable before 1.0 and are listed in §11.

## 2. Key decisions

| Decision | Choice |
|---|---|
| `emit` result | `{ started: string[]; rejected: EmitRejection[] }`. `emit` no longer throws `FlowlineValidationError`; storage errors still propagate. |
| Observability of non-run outcomes | A new `EngineOptions.onTriggerEvent` receives `TriggerEvent`s (`trigger.rejected`, `trigger.deduped`, `poll.completed`, `poll.failed`). They are not persisted by storage; the host persists them if it needs an audit table. Rejections and poll failures are also logged at `warn`. |
| Run IDs | Always `run_<32 hex>` from `crypto.randomUUID()`, never derived from a key. |
| Dedupe storage | `claimDedupeKey(tenantId, key, runId, now, windowMs) → { runId, claimed }`: atomic insert-or-get. Replaces `recordDedupeKey`. |
| Window precedence | call-site `dedupe.window` → trigger `dedupe.window` → `EngineOptions.dedupe.defaultWindow` (default 7 days, the current TTL). |
| Key precedence (events) | The trigger's `dedupe.key` wins over the call-site key; the call-site key applies to triggers that define none. (Today the call-site key wins. See §4.4.) |
| Window expiry while a run is active | The window bounds duplicate *suppression*, not run lifetime: after expiry a delivery with the same key starts a new run even if the first is still running or waiting. No "one active run per key" mode. |
| Dedupe key namespace for event triggers | `event:<workflowId>:<key>` for every event trigger (the event name is dropped), so a multi-event trigger's events dedupe against each other. |
| Multi-event definition | `events: string[]` + `normalize(event, payload)`; mutually exclusive with `event`. `normalize` returning `undefined` skips the delivery (like `filter`). `core.event` stays single-event. |
| Compare mode | `compare?: "strict" \| "loose"` on the condition's top-level rule group and on the switch node. Resolution: rule set → builtin default (host option) → `"loose"`. |
| Host default & custom operators | `createBuiltinPlugin({ compare?, operators? })` returns the `core` plugin; `builtinPlugin` is `createBuiltinPlugin()` (loose, no custom operators). Custom operators are published to the editor through the manifest (`UiMeta.operators` + `enumLabels`). |
| Typed literals | The rules widget stores the right-hand literal in the left operand's type (number field → `5`, boolean → `true`, `in` → a typed array). Strict mode never coerces; loose mode still accepts old string literals. |
| Poll storage | One `PollState` row per `(tenantId, workflowId)` with `since`, `cursor`, `nextAt` and a lease; `claimPoll` / `commitPoll` are atomic and lease-guarded so intervals never overlap, even across processes. |
| Poll items | `{ key, payload }[]`; each starts a run with dedupe key `poll:<workflowId>:<key>`; invalid items are rejected individually (same isolation rule as `emit`). |
| Poll catch-up cap | One `poll` call covers at most `maxInterval` (per trigger; engine default `"24h"`); a backlog is caught up in successive calls within a tick, at most `maxCallsPerTick` (default 10) per workflow per tick, then resumes on the next tick from the saved `since`/`cursor`. |
| Postgres v4 dedupe rows | Pre-1.0, so no backward-compat guarantee: v4 adds `run_id` and deletes rows that have none. Existing 0.1.0 deployments reset their dedupe history once on upgrade; no backfill. |
| Poll run origin | `RunOrigin` gains `{ kind: "poll"; since; until; itemKey }`. |

## 3. Emit failure isolation

### 3.1 API

```ts
// @flowlinejs/engine
export interface EmitRejection {
  /** The workflow whose trigger rejected the delivery. */
  workflowId: string;
  /** Its published version. */
  version: number;
  /** Why, e.g. `Event "deal.updated" for workflow "deal-won": field "deal.amount" expected number`. */
  message: string;
  /** The validation issues (`code: "config.invalid"` for payload problems). */
  issues: Issue[];
}

export interface EmitResult {
  /** IDs of the runs this call started, in workflow ID order. */
  started: string[];
  /** Matches that could not start, in workflow ID order. Empty when everything started or deduped. */
  rejected: EmitRejection[];
}

export interface DedupeOptions {
  /** Key identifying duplicate deliveries. Namespaced per workflow by the engine. */
  key?: string;
  /** How long the key suppresses duplicates: ms, or a duration such as `"30m"`, `"2d"`. */
  window?: DurationInput;
}

interface Engine {
  emit(event: string, payload: unknown, opts: { tenantId: string; dedupe?: DedupeOptions }): Promise<EmitResult>;
}
```

`DurationInput = number | string` lives in `@flowlinejs/core` (`types.ts`); the engine parses strings with `parseDuration` from `@flowlinejs/nodes-builtin` (max `MAX_DURATION_MS`).

### 3.2 Semantics

For every published workflow of the tenant whose trigger is an `event` trigger listening to `event` (`def.event`, `def.events` includes it, or `config.event` of `core.event`), the engine evaluates the match **independently**:

1. `normalize(event, payload)` when defined (§5); `undefined` → skip.
2. Validate the (normalized) payload against the trigger's payload schema / dynamic fields.
3. `filter({ config, payload })`; `false` → skip.
4. `dedupe.key({ config, payload, event })` (or the call-site key).
5. Launch.

Any step that throws or fails validation produces one `EmitRejection` for that workflow and does not affect the others. A skip (filter `false`, normalize `undefined`) is neither started nor rejected. A workflow whose trigger config no longer parses is skipped with a `warn` log, as today.

Matches are processed in workflow ID order; `started` and `rejected` keep that order. Rejections are reported through:

- the return value;
- `logger.warn("trigger rejected delivery", { tenantId, workflowId, event, message })`;
- `onTriggerEvent({ type: "trigger.rejected", … })` (§3.3).

`start` (one workflow) still throws `FlowlineValidationError`; `receiveWebhook` still returns `{ status: "invalid" }`. Only fan-out paths (`emit`, poll items) isolate.

### 3.3 Trigger events

```ts
// @flowlinejs/engine
export type TriggerEvent =
  | {
      type: "trigger.rejected";
      at: number;
      tenantId: string;
      workflowId: string;
      version: number;
      source: { kind: "event"; event: string } | { kind: "poll"; itemKey: string };
      message: string;
      issues: Issue[];
    }
  | {
      type: "trigger.deduped";
      at: number;
      tenantId: string;
      workflowId: string;
      /** The run the key already belongs to. */
      runId: string;
      /** The namespaced key, e.g. `event:deal-won:evt_123`. */
      key: string;
      source: RunOrigin;
    }
  | { type: "poll.completed"; at: number; tenantId: string; workflowId: string; since: number; until: number; items: number; started: number; rejected: number }
  | { type: "poll.failed"; at: number; tenantId: string; workflowId: string; since: number; until: number; message: string; nextAt: number };

interface EngineOptions {
  /** Called with every trigger-level outcome that has no run to attach to. Errors thrown here are logged and ignored. */
  onTriggerEvent?: (e: TriggerEvent) => void;
}
```

`trigger.rejected` payloads never include the delivered payload (it may carry PII and is not redacted); the message names the failing field.

## 4. Time-windowed dedupe

### 4.1 Storage

```ts
// @flowlinejs/engine storage.ts
export interface DedupeClaim {
  /** The run the key belongs to: `runId` as given when `claimed`, else the earlier claimant's. */
  runId: string;
  /** Whether this call recorded the key. */
  claimed: boolean;
}

interface StorageAdapter {
  /**
   * Insert-or-get for the tenant's `key`. When the key is absent or expired (`expiresAt <= now`),
   * record `{ runId, expiresAt: now + windowMs }` and return `{ runId, claimed: true }`; otherwise
   * leave the record unchanged and return its `runId` with `claimed: false`. Atomic: of concurrent
   * calls with one key, exactly one claims, and every other call returns the claimant's `runId`.
   */
  claimDedupeKey(tenantId: string, key: string, runId: string, now: number, windowMs: number): Promise<DedupeClaim>;
}
```

`recordDedupeKey` is removed.

**Memory adapter:** `Map<"<tenant>\0<key>", { runId, expiresAt }>`; single-threaded, so the check-and-set is atomic by construction.

**Postgres adapter** (one statement, hence atomic under concurrency):

```sql
INSERT INTO dedupe_keys AS d (tenant_id, key, run_id, expires_at) VALUES ($1, $2, $3, $4)
ON CONFLICT (tenant_id, key) DO UPDATE SET
  run_id     = CASE WHEN d.expires_at <= $5 THEN EXCLUDED.run_id     ELSE d.run_id     END,
  expires_at = CASE WHEN d.expires_at <= $5 THEN EXCLUDED.expires_at ELSE d.expires_at END
RETURNING run_id
```

`claimed = rows[0].run_id === runId`. The `DO UPDATE` always takes the row lock, so two concurrent claims serialize and the loser reads the winner's `run_id`.

**Migration v4** (`storage-postgres/src/schema.ts`):

```sql
ALTER TABLE dedupe_keys ADD COLUMN IF NOT EXISTS run_id text;
-- Pre-1.0, so no backward-compat guarantee: rows written before v4 (by an existing 0.1.0
-- deployment) have no run id, so dedupe history is reset once rather than reconstructed from
-- the old derived-id scheme.
DELETE FROM dedupe_keys WHERE run_id IS NULL;
ALTER TABLE dedupe_keys ALTER COLUMN run_id SET NOT NULL;
```

(All three statements are safe to repeat: after the first run there are no `NULL` rows.) The poll table also ships in v4 (§7.3). Consequence, documented in §11: a duplicate delivery whose key was recorded before the migration is not suppressed after it.

### 4.2 Engine launch protocol

```
launch(v, payload, origin, dedupe?: { key: string; windowMs: number }):
  runId = "run_" + randomUUID hex                 // pre-generated, random
  if dedupe:
    claim = storage.claimDedupeKey(v.tenantId, dedupe.key, runId, now, dedupe.windowMs)
    if !claim.claimed:
      runId = claim.runId
      if storage.getRun(v.tenantId, runId) exists → publish trigger.deduped; return { runId, created: false }
      // else: a delivery crashed between claiming the key and creating the run — create it now
  run = storage.createRun({ id: runId, … }, [run.started], now)   // idempotent on id
  created = claim?.claimed !== false && run.createdAt === now
  if created: publish(run.started)
  return { runId, created }
```

Guarantees kept from v1:

- **Concurrent or retried deliveries start exactly one run.** Only one claim wins; every loser gets the winner's run ID and finds (or, after a crash, recovers) that run.
- **A crash between claiming the key and creating the run** loses nothing: the key stores the pre-generated run ID, so the retry creates exactly that run. As today, the recovering delivery is answered as a duplicate (`created: false`) and its `run.started` does not reach `onEvent`; the run executes normally.

### 4.3 Configuring windows

```ts
// @flowlinejs/core define.ts
export interface TriggerDedupe<C extends z.ZodObject, P> {
  /** A key identifying duplicate deliveries; `undefined` → no dedupe for this delivery. */
  key(args: { config: z.infer<C>; payload: P; event?: string }): string | undefined;
  /** How long a key suppresses duplicates. Default: the engine's `dedupe.defaultWindow`. */
  window?: DurationInput;
}

interface TriggerDefinition<C, P> {
  dedupe?: TriggerDedupe<C, P>;   // replaces `dedupeKey`
}

// @flowlinejs/engine
interface EngineOptions {
  dedupe?: {
    /** Window used when neither the call nor the trigger sets one. Default `"7d"`. */
    defaultWindow?: DurationInput;
  };
}
interface Engine {
  start(opts: { tenantId: string; workflowId: string; input?: unknown; dedupe?: DedupeOptions; startedBy?: RunOrigin }): Promise<string>;
}
```

- `core.webhook` config gains `dedupeWindow` (optional duration string, validated with `parseDuration`) next to `dedupeHeader`.
- `POST /workflows/:id/run` accepts an optional `dedupe: { key?, window? }` body field.
- Schedules keep `schedule:<workflowId>:<fireAt>` with the default window.

Namespaces: `event:<wf>:<key>`, `start:<wf>:<key>`, `webhook:<wf>:<key>`, `schedule:<wf>:<fireAt>`, `poll:<wf>:<itemKey>`.

### 4.4 Key precedence

| Path | Key |
|---|---|
| `emit` | trigger `dedupe.key(...)` if the trigger defines `dedupe` and it returns a string; else `opts.dedupe.key`; else none |
| `start` | `opts.dedupe.key` |
| webhook | `config.dedupeHeader` header value; else trigger `dedupe.key(...)`; else none |
| poll | always `item.key` |

Why the trigger wins for `emit`: a trigger's key expresses "the same thing" in domain terms (a booking ID across two event types); a call-site key is typically a delivery ID (outbox event ID) that is only meaningful for retries. When the trigger key is used, redelivery of the same event still dedupes because the same payload yields the same key.

### 4.5 Window expiry while a run is active

The window is a suppression interval, nothing more. When it expires:

- a later delivery with the same key claims the key anew and starts a **new** run, with a fresh random ID, whether or not the first run has finished;
- the first run is unaffected (never cancelled, never re-keyed);
- nothing extends a window: a suppressed duplicate does not renew it.

Hosts that need "at most one active run per entity" express it in the workflow (load the entity, condition, stop) or with a window longer than the workflow's longest wait. `trigger.deduped` events let hosts observe suppression.

### 4.6 Conformance additions

`runStorageConformance` gains, under `describe("dedupe")`:

- first claim → `{ runId: given, claimed: true }`; second within the window → `{ runId: first, claimed: false }` and the stored expiry is unchanged;
- at `now === expiresAt` the key is expired: a claim with a new ID wins and returns it;
- ten concurrent claims → exactly one `claimed: true`, all ten report the same `runId`;
- keys are per tenant;
- a claim with the same run ID twice (idempotent retry) → second is `claimed: false` with that ID.

The Postgres test also covers migration v4: a v3-shaped row (`run_id` null) inserted before `migrate()` is gone afterwards, and a claim on its key wins with the new run ID.

## 5. Multi-event triggers

### 5.1 API

```ts
// @flowlinejs/core define.ts
export interface TriggerDefinition<C extends z.ZodObject = z.ZodObject, P = unknown> {
  kind: TriggerKind;                       // "event" | "webhook" | "manual" | "schedule" | "subflow" | "poll"
  /** For `event` triggers listening to one event. Mutually exclusive with `events`. */
  event?: string;
  /** For `event` triggers listening to several events. Requires `normalize`. */
  events?: readonly string[];
  /**
   * Map a raw event payload onto this trigger's payload shape. Called before payload validation
   * with the delivered event name. Return `undefined` to ignore the delivery.
   */
  normalize?(event: string, payload: unknown): P | undefined;
  filter?(args: { config: z.infer<C>; payload: P; event?: string }): boolean;
  dedupe?: TriggerDedupe<C, P>;
}
```

`defineTrigger` throws `FlowlineDefinitionError` when: both `event` and `events` are set; `events` is empty or has duplicates; `events` is set without `normalize`; `events`/`normalize` are set on a non-`event` kind.

### 5.2 Manifest and matching

`TriggerManifest` gains `events?: string[]`. Matching in `emit`: a trigger listens to `event` when `def.event === event`, `def.events?.includes(event)`, or (for `core.event`) `config.event === event`.

The run's `startedBy` is `{ kind: "event", event }` with the **raw** event name, so the run viewer and `listRuns` show which source fired. The normalized payload is the run's `trigger` scope; hosts that want the source inside the payload add it in `normalize` (the example below does).

### 5.3 Dedupe namespace

`event:<workflowId>:<key>` for all event triggers. For a multi-event trigger the key function sees `event`, and returning the same key for related events across sources dedupes them against each other within the window.

### 5.4 Example (mini-crm, "Any call ended")

```ts
const CallEnded = z.object({
  call: z.object({
    id: z.string(), contactId: z.string(), source: z.enum(["ai", "voip"]),
    durationSec: z.number(), endedAt: z.iso.datetime(), summary: z.string().optional(),
  }),
});

export const callEnded = defineTrigger({
  type: "crm.callEnded", name: "Any call ended", kind: "event", icon: "phone-off",
  events: ["ai_call.ended", "voip_call.ended"],
  config: z.object({ minSeconds: ui(z.number().int().min(0), { label: "Minimum length (seconds)" }).default(0) }),
  payload: CallEnded,
  normalize: (event, raw) => {
    if (event === "ai_call.ended") {
      const r = raw as { call: { id: string; contactId: string; seconds: number; endedAt: string; transcriptSummary: string } };
      return { call: { id: r.call.id, contactId: r.call.contactId, source: "ai", durationSec: r.call.seconds, endedAt: r.call.endedAt, summary: r.call.transcriptSummary } };
    }
    const r = raw as { callId: string; contactId: string; durationMs: number; endedAt: string };
    return { call: { id: r.callId, contactId: r.contactId, source: "voip", durationSec: Math.round(r.durationMs / 1000), endedAt: r.endedAt } };
  },
  filter: ({ config, payload }) => payload.call.durationSec >= config.minSeconds,
  dedupe: { key: ({ payload }) => payload.call.id, window: "1h" },
});
```

"Combined booking cancellation" is the same shape: `events: ["booking.cancelled", "appointment.status_changed"]`, `normalize` returns `undefined` for status changes other than `cancelled`, and `dedupe.key` returns the booking ID so both sources start one run.

### 5.5 UI

- **Trigger picker** (`TriggerTypeSelect` in the config panel): unchanged list, but each option's secondary text shows `event` or `events.join(", ")` so multi-event triggers are recognisable.
- **Trigger card** caption: `labels.triggerEvents(events)` → "When any of: ai_call.ended, voip_call.ended" (truncated with "+N more" past three).
- **Trigger config** hint: the info callout lists every event and says the payload is normalized.
- `labels.ts`: `triggerEvents(events: string[]): string`, `triggerEventsHint(events: string[]): string`.

## 6. Condition semantics

### 6.1 Compare modes

```ts
// @flowlinejs/nodes-builtin rules.ts
export type CompareMode = "strict" | "loose";

/** The top-level group of a condition: a rule group plus the compare mode. */
export interface ConditionRules extends RuleGroup {
  /** Default: the mode `createBuiltinPlugin` was given, else `"loose"`. */
  compare?: CompareMode;
}

export interface EvaluateOptions {
  compare?: CompareMode;
  /** Host operators by id (from `createBuiltinPlugin({ operators })`). */
  operators?: Readonly<Record<string, CustomOperator>>;
}
export function evaluateRules(g: RuleGroup | ConditionRules, opts?: EvaluateOptions): boolean;
export function strictEquals(a: unknown, b: unknown): boolean;
export function looseEquals(a: unknown, b: unknown, opts?: EqualsOptions): boolean;   // unchanged
```

`compare` is only meaningful on the top-level group (`ConditionRulesSchema`); nested groups inherit. `core.switch` gains `compare?: CompareMode` on its input, next to `caseSensitive`.

Resolution order: `rules.compare` → the builtin plugin's `compare` option → `"loose"`. The chosen default is visible to the editor because `ConditionRulesSchema.compare` and the switch's `compare` are `z.enum(["strict", "loose"]).default(<option>)`, and the manifest carries schema defaults.

### 6.2 Strict semantics

Strict mode compares **values of the same type only**. There is no numeric parsing of strings, no boolean parsing, no case folding (`caseSensitive` is ignored: always case-sensitive), and no splitting of comma-separated text.

Unset handling: `null` and `undefined` (a missing field) are distinct values. `eq`/`neq` compare them literally (`null` equals `null`; `undefined` equals `undefined`; `null` ≠ `undefined`). Every other binary operator is `false` when either side is `null`/`undefined`. Unary emptiness operators are unchanged (§6.3).

`strictEquals(a, b)`: `a === b` for primitives (NaN never equal); arrays deep by index; plain objects deep by own keys (order-insensitive); everything else `false`.

### 6.3 Operator table: strict vs loose

| Operator | Loose (today's behaviour) | Strict |
|---|---|---|
| `eq` / `neq` | `looseEquals`: numeric text as numbers, `"true"`/`"false"` as booleans, ISO dates by instant, `null` = `undefined`, case-insensitive unless `caseSensitive` | `strictEquals` |
| `gt` `gte` `lt` `lte` | numbers or numeric text as numbers; then ISO date text by instant; then text by code point; else `false` | both numbers → numeric; both strings → by instant when **both** are ISO date strings, else by code point; any other pair (incl. `null`/`undefined`) → `false` |
| `contains` / `notContains` | text: substring of `String(left)` (numbers/booleans stringified), case-folded; array: some item `looseEquals` | text: `left` and `right` both strings, case-sensitive substring; array: some item `strictEquals`; else `false` (`notContains` = `!contains`) |
| `startsWith` / `endsWith` | stringified primitives, case-folded | both strings, case-sensitive; else `false` |
| `in` | `right` array, or comma-separated text (items trimmed); items `looseEquals` | `right` must be an array; items `strictEquals`; text `right` → `false` |
| `isEmpty` / `isNotEmpty` | `null`, `undefined`, `""`, `[]`, `{}` | same |
| `isTrue` / `isFalse` | `true`/`"true"`, `false`/`"false"` | `true` / `false` only |
| custom (`isUnassigned`, …) | `evaluate(left, right, { compare: "loose" })` | `evaluate(left, right, { compare: "strict" })` |
| unknown operator id | `false` | `false` |
| empty `and` / `or` group | `true` / `false` | same |

### 6.4 Value-pair examples

| left | op | right | loose | strict |
|---|---|---|---|---|
| `5` | eq | `5` | true | true |
| `5` | eq | `"5"` | true | **false** |
| `"5"` | eq | `"5.0"` | true | **false** |
| `"Won"` | eq | `"won"` | true (false with `caseSensitive`) | **false** |
| `true` | eq | `"true"` | true | **false** |
| `"2026-01-31"` | eq | `"2026-01-31T00:00:00Z"` | true | **false** (different text) |
| `null` | eq | `undefined` | true | **false** |
| `null` | eq | `null` | true | true |
| `[1, 2]` | eq | `["1", "2"]` | true | **false** |
| `{ a: 1 }` | eq | `{ a: 1 }` | true | true |
| `5` | lt | `"10"` | true | **false** (mixed types) |
| `"5"` | lt | `"10"` | true (numeric) | **false** (`"5" > "10"` by code point) |
| `"2026-02-01"` | gt | `"2026-01-31T09:00Z"` | true | true (both ISO) |
| `null` | gt | `0` | false | false |
| `"Hello world"` | contains | `"hello"` | true | **false** |
| `12345` | contains | `"23"` | true | **false** |
| `[1, 2]` | contains | `"2"` | true | **false** |
| `[1, 2]` | contains | `2` | true | true |
| `"won"` | in | `"won, lost"` | true | **false** |
| `5` | in | `["5"]` | true | **false** |
| `5` | in | `[5]` | true | true |
| `"true"` | isTrue | — | true | **false** |
| `1` | isTrue | — | false | false |
| `""` | isEmpty | — | true | true |
| `"  "` | isEmpty | — | false | false |
| `0` | isEmpty | — | false | false |
| `undefined` | isUnassigned (host) | — | host-defined | host-defined |

### 6.5 Typed literals (editor)

Today the rules widget stores every right-hand literal as text (`RefTextInput`). With typed literals the widget stores a literal in the **left operand's value type** (`valueTypeOf(rule.left, scope)`):

| Left type | Right control | Stored literal |
|---|---|---|
| `number` | numeric input (refs still allowed) | `5`, not `"5"`; non-numeric text is kept as text and flagged (`rule.literalType` warning) |
| `boolean` | true/false select | `true` / `false` |
| `string` / `date` | text (date picker hint) | string |
| `array`, `object`, `any` | text | string (loose) — strict users compare with a reference |
| any type with op `in` | tag list | array of typed items: `[5, 7]` for numbers, `["won", "lost"]` for text |

A literal typed differently from the left operand under `compare: "strict"` (e.g. a leftover `"5"` on a number field) raises the editor-side warning issue `rule.literalType` on the rule ("Compare with is text but Value is a number; strict mode will never match"). The warning is produced by the widget (it owns the format), not by the core validator.

### 6.6 Host-registered operators

```ts
// @flowlinejs/nodes-builtin
export type RuleValueType = "string" | "date" | "number" | "boolean" | "array" | "object" | "any";

export interface CustomOperator {
  /** Operator id used in rules, e.g. `"isUnassigned"`. Must not collide with a built-in `RuleOp`. */
  id: string;
  /** Editor label, e.g. `"is unassigned"`. */
  label: string;
  arity: "unary" | "binary";
  /** Left-value types the editor offers it for. Default: every type. */
  types?: RuleValueType[];
  /** Evaluate a resolved rule. */
  evaluate(left: unknown, right: unknown, ctx: { compare: CompareMode }): boolean;
}

export interface BuiltinOptions {
  /** Default compare mode of `core.condition` and `core.switch`. Default `"loose"`. */
  compare?: CompareMode;
  /** Additional rule operators. */
  operators?: CustomOperator[];
}

/** The built-in `core` plugin with host choices applied. */
export function createBuiltinPlugin(opts?: BuiltinOptions): PluginDefinition;
/** `createBuiltinPlugin()`: loose, no custom operators. */
export const builtinPlugin: PluginDefinition;
```

`createBuiltinPlugin` throws `FlowlineDefinitionError` on a duplicate or built-in operator id. The host registers the plugin itself (`createRegistry([createBuiltinPlugin({ compare: "strict", operators: [isUnassigned] }), crmPlugin])`); `createEngine` keeps adding `builtinPlugin` only when no `core` plugin is present, so the same registry serves the engine and the editor manifest.

Manifest transport: the `op` field of `RuleSchema` becomes `z.enum([...RULE_OPS, ...customIds])` with `ui(..., { enumLabels: { isUnassigned: "is unassigned", … }, operators: [{ id, label, arity, types }] })`. `UiMeta` in core gains:

```ts
// @flowlinejs/core types.ts
export interface RuleOperatorMeta { id: string; label: string; arity: "unary" | "binary"; types?: RuleValueType[] }
interface UiMeta { operators?: RuleOperatorMeta[] }
```

The rules widget merges `operators` into its `UNARY`/`OPS_BY_TYPE` tables at render time. Custom operators are evaluated by `core.condition` only; `core.switch` cases always use `eq` semantics in the selected compare mode (custom operators in switch cases are out of scope, §14).

Example:

```ts
const isUnassigned: CustomOperator = {
  id: "isUnassigned", label: "is unassigned", arity: "unary",
  types: ["string", "object", "any"],
  evaluate: (left) => left === null || left === undefined || left === "",
};
```

### 6.7 Code-first helpers

```ts
export function strictly(group: RuleGroup): ConditionRules;   // { ...group, compare: "strict" }
export function loosely(group: RuleGroup): ConditionRules;    // { ...group, compare: "loose" }
export function custom(op: string, left: unknown, right?: unknown): Rule;
```

`and`/`or`/`eq`/… are unchanged.

### 6.8 UI

Rules widget (`panel/widgets/rules.tsx`):

- a **Compare** select (`Strict` / `Loose`) on the top-level group, defaulting from the schema default; a one-line hint per mode (`labels.compareStrictHint`, `labels.compareLooseHint`);
- the **Match case** toggle is hidden under strict;
- typed right-hand controls per §6.5, including the `in` tag list;
- custom operators listed with their labels, filtered by `types`;
- the `rule.literalType` warning.

Switch cases widget: a **Compare** select next to Match case; case `value` literals are typed by the switch's `value` operand type, same rules.

## 7. Poll trigger kind

### 7.1 Definition API

```ts
// @flowlinejs/core define.ts
export interface PollItem<P> { /** Identifies the item within the workflow; dedupe key `poll:<wf>:<key>`. */ key: string; payload: P }
export interface PollResult<P> { items: PollItem<P>[]; /** Stored and handed back on the next poll. Must be JSON. */ cursor?: unknown }
export interface PollContext {
  tenantId: string;
  workflowId: string;
  services: FlowlineServices;
  logger?: Logger;
  /** Aborted when the poll lease is lost. */
  signal: AbortSignal;
}
export interface PollArgs<C> {
  config: C;
  /** Start of the interval (exclusive): the previous interval's `until`, or the workflow's `publishedAt` for the first poll. */
  since: number;
  /** End of the interval (inclusive): the engine's clock at claim time. */
  until: number;
  /** The cursor returned by the previous successful poll, or `null`. */
  cursor: unknown;
  ctx: PollContext;
}

interface TriggerDefinition<C, P> {
  kind: "poll";
  /** Select the items that became due in `(since, until]`. */
  poll?(args: PollArgs<z.infer<C>>): Promise<PollResult<P>> | PollResult<P>;
  /** Minimum time between polls of one workflow. Default: `EngineOptions.poll.defaultInterval` (`"1m"`). */
  interval?: DurationInput;
  /**
   * Longest interval one `poll` call covers (`until - since`). A longer backlog (after downtime)
   * is caught up in successive calls. Default: `EngineOptions.poll.defaultMaxInterval` (`"24h"`).
   */
  maxInterval?: DurationInput;
}
```

`defineTrigger` throws when `kind: "poll"` lacks `poll`, when `poll`/`interval`/`maxInterval` appear on another kind, or when `maxInterval < interval`. `TriggerManifest` gains `interval?: number` and `maxInterval?: number` (ms). `TriggerKind` gains `"poll"`. `RunOrigin` gains `{ kind: "poll"; since: number; until: number; itemKey: string }`.

### 7.2 Engine loop

```ts
interface Engine { tickPolls(): Promise<number> }         // runs started
interface WorkerOptions { pollEveryMs?: number }          // default 15_000; first loop only, like tickSchedules
interface EngineOptions {
  poll?: {
    defaultInterval?: DurationInput;      // "1m"
    defaultMaxInterval?: DurationInput;   // "24h"
    /** Upper bound on `poll` calls per workflow in one `tickPolls` while catching up. Default 10. */
    maxCallsPerTick?: number;
    leaseMs?: number;                     // 60_000
  };
}
```

`tickPolls`, for every published workflow (all tenants) whose trigger kind is `poll`:

1. `lease = storage.claimPoll(tenantId, workflowId, { workerId, leaseMs, now })`; `null` (not due, or leased elsewhere) → skip.
2. `since = lease.state.since ?? publishedAt`. If `now <= since` → `commitPoll(lease, { nextAt: since + interval }, now)` and skip.
3. `until = min(now, since + maxInterval)`. Call `def.poll({ config, since, until, cursor, ctx })` with a lease-renewing timer (like executor leases); losing the lease aborts `ctx.signal`.
4. On throw (or lease lost): `commitPoll(lease, { nextAt: now + interval, lastError: message }, now)` — `since` and `cursor` are **not** advanced, so the next poll covers the same interval again; publish `poll.failed`; log `warn`; stop this workflow for the tick.
5. Per item, in array order: validate the payload against the trigger's payload schema → `trigger.rejected` (source `{ kind: "poll", itemKey }`) or `launch(v, payload, { kind: "poll", since, until, itemKey }, { key: "poll:<wf>:<itemKey>", windowMs })`.
6. Advance: `since = until`, `cursor = result.cursor ?? null`; publish `poll.completed` for this call.
7. **Catch-up:** if `until < now` (the call was capped by `maxInterval`) and fewer than `maxCallsPerTick` calls were made for this workflow in this tick, go to 3 with the new `since`/`cursor`. Otherwise `commitPoll(lease, { since, cursor, nextAt: until < now ? now : until + interval, lastError: null }, now)`.

The chain of calls in one tick runs under one lease. Each call's `since`/`cursor` are held in memory until the final `commitPoll`, except that a call's advance is committed **before** the next call starts (`commitPoll` keeps the lease when `patch.keepLease` is set — see §7.3), so a crash mid-chain loses at most the items of the call in flight, which the dedupe keys cover on the retry.

Non-overlap: the lease guarantees one poller per workflow at a time and `since`/`until` form a contiguous, gap-free sequence of half-open intervals `(since, until]`. Bounded: no call covers more than `maxInterval`, and no tick makes more than `maxCallsPerTick` calls per workflow. After downtime longer than `maxInterval`, the backlog is caught up in chunks of `maxInterval`: up to `maxCallsPerTick` chunks per tick, with `nextAt = now` so the next tick continues at once (rather than waiting `interval`). Items that became due during downtime still fire once; a `poll` implementation only ever answers for an interval of at most `maxInterval`.

Crash between launching items and `commitPoll`: the lease expires, the interval is polled again, and the per-item dedupe keys make the already-started items dedupe (within the window; the default 7 days comfortably exceeds any `maxInterval`). Delivery is therefore at-least-once per item, exactly-once within the window.

Worked timings (interval `1m`, `maxInterval` `24h`, `maxCallsPerTick` 10): after a 3-day outage the first tick makes calls for `(t0, t0+24h]`, `(t0+24h, t0+48h]`, `(t0+48h, t0+72h]` and the tail `(t0+72h, now]` (4 calls, `until` reached `now`), commits `nextAt = now + 1m`, and steady state resumes. After a 30-day outage the first tick makes 10 calls covering 10 days, commits `nextAt = now`, and the next tick (about `pollEveryMs` later) continues from day 10 with a fresh lease.

Republishing a workflow keeps its poll state; changing the trigger to another kind leaves the row orphaned (harmless, never claimed). Deleting a workflow is out of scope, as today.

### 7.3 Storage

```ts
// @flowlinejs/engine storage.ts
export interface PollState {
  tenantId: string;
  workflowId: string;
  /** End of the last completed interval; `null` before the first successful poll. */
  since: number | null;
  /** Cursor from the last successful poll; `null` initially. */
  cursor: unknown;
  /** Earliest time the workflow may be polled again (`0` initially). */
  nextAt: number;
  /** Message of the last failed poll; cleared by a successful one. */
  lastError?: string;
  leaseOwner?: string;
  leaseUntil?: number;
  updatedAt: number;
}
export interface PollLease { state: PollState; token: string }
export interface PollPatch {
  since?: number;
  cursor?: unknown;
  nextAt: number;
  lastError?: string | null;
  /** Keep the lease (same token) instead of releasing it: used between catch-up calls of one tick. */
  keepLease?: boolean;
}

interface StorageAdapter {
  /**
   * Claim the poll state of `(tenantId, workflowId)` for `leaseMs` when `nextAt <= now` and it is
   * not leased (`leaseUntil` unset or `< now`). Creates the state (`since: null, cursor: null,
   * nextAt: 0`) when missing. Returns `null` (no write) otherwise. Atomic: of concurrent claims,
   * exactly one succeeds.
   */
  claimPoll(tenantId: string, workflowId: string, opts: { workerId: string; leaseMs: number; now: number }): Promise<PollLease | null>;
  /** Renew the poll lease; `false` when the token is no longer current. */
  renewPollLease(lease: PollLease, leaseMs: number, now: number): Promise<boolean>;
  /**
   * Apply `patch`, set `updatedAt = now` and release the lease (unless `patch.keepLease`, which
   * keeps the same token current), guarded by the token: `false` and no write when the token is
   * stale. `cursor` is replaced (not merged); `lastError: null` clears.
   */
  commitPoll(lease: PollLease, patch: PollPatch, now: number): Promise<boolean>;
  /** The state, or `null`. */
  getPollState(tenantId: string, workflowId: string): Promise<PollState | null>;
}
```

Postgres table (migration v4):

```sql
CREATE TABLE IF NOT EXISTS poll_states (
  tenant_id text NOT NULL, workflow_id text NOT NULL,
  since bigint, cursor jsonb, next_at bigint NOT NULL DEFAULT 0, last_error text,
  lease_owner text, lease_until bigint, lease_token text, updated_at bigint NOT NULL,
  PRIMARY KEY (tenant_id, workflow_id)
);
CREATE INDEX IF NOT EXISTS poll_states_next_at_idx ON poll_states (next_at);
```

`claimPoll` = `INSERT … ON CONFLICT DO NOTHING` then a single `UPDATE … SET lease_* WHERE tenant_id=$1 AND workflow_id=$2 AND next_at <= $now AND (lease_until IS NULL OR lease_until < $now) RETURNING *`.

### 7.4 Conformance additions

Under `describe("polls")`:

- first `claimPoll` creates and returns the initial state (`since: null`, `cursor: null`, `nextAt: 0`) with lease fields set;
- a second claim while leased → `null`; after `leaseUntil` passes → a new lease with a different token;
- `commitPoll` with a stale token → `false`, nothing changes; with the current token → patch applied, lease cleared, `updatedAt = now`;
- `nextAt > now` → `null`; equal → claimable;
- ten concurrent claims → exactly one lease;
- `cursor` round-trips JSON (objects, arrays, `null`) and is replaced, not merged;
- `lastError: null` clears; `since` unset in a patch leaves the value;
- `renewPollLease` true while current, false after `commitPoll`; still true after `commitPoll` with `keepLease: true`, whose patch is applied and whose token stays current (a second `commitPoll` with the same lease succeeds; a concurrent `claimPoll` returns `null` meanwhile);
- tenant isolation (`getPollState` of the other tenant is `null`).

### 7.5 Worked example: "Deal stuck in stage for N days" (mini-crm)

**Domain change.** `Deal` gains `stageEnteredAt: z.iso.datetime()`; the store sets it whenever `stage` changes (and at seed time).

**Trigger** (`examples/mini-crm/server/src/plugin/triggers.ts`):

```ts
const DAY = 86_400_000;
export const dealStuckInStage = defineTrigger({
  type: "crm.dealStuckInStage", name: "Deal stuck in stage", kind: "poll", icon: "hourglass",
  description: "Start once for each deal that has been in a stage for a number of days.",
  interval: "10s",   // short so the demo and its e2e tests are quick; a real CRM would poll every few minutes
  config: z.object({
    stage: ui(z.enum(DEAL_STAGES), { label: "Stage" }),
    days: ui(z.number().int().min(1), { label: "Days in stage" }).default(3),
  }),
  payload: z.object({ deal: DealSchema, days: z.number() }),
  poll: ({ config, since, until, ctx }) => ({
    items: ctx.services.crm
      .listDeals()
      .filter((d) => d.stage === config.stage)                       // eligibility: still in the stage now
      .filter((d) => {
        const due = Date.parse(d.stageEnteredAt) + config.days * DAY;
        return due > since && due <= until;                          // crossed the threshold in this interval
      })
      .map((d) => ({ key: `${d.id}:${d.stageEnteredAt}`, payload: { deal: d, days: config.days } })),
  }),
});
```

Why this matches the customer's sweep and not a cron / "wait 3 days":

- **Eligibility** is evaluated at sweep time against current state; a deal that left the stage before its threshold never fires. A "deal.updated → wait 3 days" workflow would have to be cancelled explicitly on every stage change.
- **Threshold crossing in a bounded interval**: the due time must fall in `(since, until]`, so a deal fires once when it crosses, not on every sweep, and not retroactively for deals that crossed before the workflow was published (`since` starts at `publishedAt`).
- **Re-entering a stage** is a new stint: `stageEnteredAt` changes, so the item key changes and a new run is legitimate; the same stint never fires twice thanks to the key.
- **Downtime** is covered: the next interval spans the gap.

**Workflow** `deal-stuck-in-stage` (`flows/deal-stuck.ts`, config `{ stage: "proposal", days: 3 }`):

1. `deal` — `crm.getDeal` (new node) reloads the deal.
2. `still_there` — `core.condition`, strict: `eq(ref("steps.deal.deal.stage"), ref("trigger.deal.stage"))`; else → `moved_on` `core.stop` ("Deal moved on").
3. `owner` — `crm.getUser` (new node) loads the deal's owner; `nudge` — `crm.sendEmail` to `steps.owner.user.email`: "{{trigger.deal.name}} has been in {{trigger.deal.stage}} for {{trigger.days}} days".
4. `wait` — `core.delay` `1d` (`1m` in the demo).
5. `recheck` — `crm.getDeal`; `still_stuck` — strict condition as in 2; else stop.
6. `escalate` — `crm.sendEmail` to manager `u_ava`.

**Cancellation on stage change.** Two layers, both demonstrated:

- *In the workflow*: every side effect is preceded by a fresh load and a strict stage check, so a run that wakes after the deal moved stops instead of nudging.
- *In the host*: `app.ts` extends its `crm.onEvent` handler — on `deal.updated` with `changes` including `stage`, it lists `waiting`/`queued` runs of `deal-stuck-in-stage` whose `trigger.deal.id` matches and calls `engine.cancelRun(tenantId, runId, { by: "system", reason: "Stage changed" })`. The run viewer shows the cancellation and its reason. This is the deliberate handling the customer asked about: cancellation is a host decision, and the workflow stays correct even without it.

## 8. Storage changes (summary)

| Method | Change |
|---|---|
| `recordDedupeKey` | **Removed.** |
| `claimDedupeKey(tenantId, key, runId, now, windowMs) → DedupeClaim` | **New.** |
| `claimPoll`, `renewPollLease`, `commitPoll`, `getPollState` | **New.** |
| Postgres migration v4 | `dedupe_keys.run_id` (pre-v4 rows deleted), `poll_states` table. |
| Conformance | `dedupe` and `polls` suites (§4.6, §7.4). |

Adapter rules (isolation, tenancy, atomicity, times, lease tokens never returned) apply to the new methods unchanged.

## 9. HTTP / API changes

- `POST /workflows/:id/run` body: `{ input?, dedupe?: { key?: string; window?: string | number } }`.
- Webhook responses unchanged; `dedupeWindow` config controls the window of `dedupeHeader` keys.
- `RunSummary.startedBy` / `RunDetail.run.startedBy` may be `{ kind: "poll", … }`.
- `Manifest.triggers[]` may carry `events` and `interval`; `UiMeta.operators` may appear on the rules `op` field.
- No route exposes poll state in this batch (see §14).

## 10. UI changes (summary)

| Area | Change |
|---|---|
| Trigger picker / config panel | Event list per trigger; multi-event callout; poll triggers show "Checks every {interval}" (`labels.triggerPoll(intervalMs)`) and the config form. |
| Trigger card | Captions for multi-event and poll triggers. |
| Rules widget | Compare select, hidden Match case under strict, typed literals, `in` tag list, custom operators, `rule.literalType` warning. |
| Cases widget (switch) | Compare select; typed case values. |
| Run list / viewer | `labels.origin` renders `{ kind: "poll" }` as "Polled (item {itemKey})". |
| Labels | `triggerEvents`, `triggerEventsHint`, `triggerPoll`, `compare`, `compareStrict`, `compareLoose`, `compareStrictHint`, `compareLooseHint`, `literalTypeWarning(leftType)`, `originPoll`. |

## 11. Migration notes (breaking before 1.0)

| Before | After | Action |
|---|---|---|
| `engine.emit(...)` resolves `string[]` and throws `FlowlineValidationError` on any invalid match | resolves `EmitResult`; never throws for validation | Read `result.started`; log/store `result.rejected` or subscribe to `onTriggerEvent`. |
| `emit(..., { dedupeKey })`, `start({ dedupeKey })` | `{ dedupe: { key, window? } }` | Rename at call sites. |
| `defineTrigger({ dedupeKey })` | `defineTrigger({ dedupe: { key, window? } })` | Rename; `key` now also receives `event`. |
| Run IDs derived from dedupe keys (reusing a key returned the original run forever) | random IDs; keys expire after the window (default 7 days) | Hosts that relied on permanent suppression set a long window per trigger. Hosts that relied on `run_<hash>` IDs being predictable must stop. |
| `StorageAdapter.recordDedupeKey` | `claimDedupeKey`, plus poll methods | Third-party adapters implement the new methods and re-run the conformance suite. |
| Postgres schema v3 | v4 (`migrate()` is idempotent): adds `dedupe_keys.run_id` and **deletes every existing dedupe row**, adds `poll_states` | Dedupe history is reset once: a delivery whose key was recorded before the migration is not suppressed after it (pre-1.0, so no backward-compat guarantee and no backfill for existing 0.1.0 deployments). Stop workers, run `migrate()`, start upgraded workers. |
| Rule literals stored as text | unchanged in loose mode | Nothing for loose hosts. Hosts switching the default to strict re-save conditions in the editor (typed literals) or rebuild them with typed values in code; a numeric-string literal under strict raises the `rule.literalType` warning. |
| `builtinPlugin` only | `createBuiltinPlugin(opts)` | Only hosts wanting strict defaults or custom operators change anything. |
| `core.event` / plugin event triggers listen to one event | `events` available | Additive. |
| `TriggerKind` | adds `"poll"` | Exhaustive `switch`es on kind (trigger card, labels) get a case. |
| `RunOrigin` | adds `{ kind: "poll" }` | Same. |

README and `docs/guides/writing-a-plugin.md` are updated with the new `emit` result, `dedupe`, `events`/`normalize`, `createBuiltinPlugin` and `kind: "poll"`; the docs-check suite typechecks them.

## 12. Edge cases

**Emit**
- Zero matches → `{ started: [], rejected: [] }`.
- A trigger whose `normalize` returns a non-object for a schema-typed payload → validation rejection, message from the first Zod issue.
- The same workflow published twice concurrently (two versions): `listPublished` returns one version per workflow; no double start.
- `filter` throws → rejection with `message: 'filter threw: …'` (today: silent skip with an `error` log).

**Dedupe**
- Empty-string key from a trigger or call site → treated as no key (as today).
- `window` of `0` would make a key expire at the moment it is claimed (`expiresAt = now`), so a concurrent duplicate with the same `now` would see an expired key and claim again. Windows must therefore be `>= 1` ms: `0`, negative and unparsable values are a `FlowlineValidationError` at the call site and a `FlowlineDefinitionError` at definition time.
- Window longer than `MAX_DURATION_MS` → same errors.
- A duplicate arriving after the run was cancelled or failed → still deduped within the window (the key points at that run; retries are for the host via `retryRun`).
- Storage clock skew: storage never reads a clock; `now` comes from the engine's injected clock in every call.

**Multi-event**
- A host emits an event the trigger lists but `normalize` cannot map → return `undefined` (skip) or throw (rejection); the trigger author chooses.
- Two workflows using the same multi-event trigger each keep their own namespace (`event:<wf>:…`).
- `events` including the name of `core.event`'s configured event: both start; they are different workflows.

**Conditions**
- Strict `eq` on two `NaN`s → `false` (`===`); loose → `false` too (`asNumber` rejects non-finite).
- `-0` vs `0` → equal in both modes.
- Strict `in` with `right` a string → `false` with no error; the editor never produces it for typed lefts.
- A custom operator throwing → the step fails fatally with the operator id in the message (a bug in host code, not a retryable condition).
- Custom operator with `arity: "binary"` and a missing `right` → `evaluate(left, undefined, ctx)`.
- Unknown `compare` value in a saved doc (hand-edited) → Zod rejects the config at validation/publish.

**Poll**
- Two engines ticking concurrently → the lease makes one claim win; the other skips.
- A poll returns items with duplicate keys in one result → the second is deduped (`trigger.deduped`), not started twice.
- A poll returns an item whose `key` is empty → rejected (`message: "item key is empty"`).
- `poll` takes longer than `leaseMs` → the lease is renewed every `leaseMs / 2`; if renewal fails, `ctx.signal` aborts and the result is discarded (`commitPoll` returns `false`), and the other holder polls the same interval.
- `interval` shorter than the worker's `pollEveryMs` → effective cadence is `pollEveryMs`.
- Workflow unpublished between claim and commit → runs already launched keep the version they pinned; `commitPoll` still succeeds; the state stays and is claimable again only if republished (only published workflows are ticked).
- Clock goes backwards (host bug): `now <= since` → nothing polled; `nextAt = since + interval`; the state is untouched, so when the clock passes `since` again the next interval starts exactly there (no gap, no overlap). A clock that steps back *between* two catch-up calls of one tick ends the chain the same way: the committed `since` stands.
- `interval` shorter than `maxInterval` (the normal case): steady-state calls cover `(since, now]`, far less than `maxInterval`; the cap only matters after a gap longer than `maxInterval`. `maxInterval` shorter than `interval` is rejected at definition time (`maxInterval < interval`).
- Gap exactly `maxInterval`: one call covers it (`until = since + maxInterval = now`); `until < now` is false, so no catch-up call follows and `nextAt = until + interval`.
- Backlog larger than `maxCallsPerTick × maxInterval`: the tick stops after `maxCallsPerTick` calls with `nextAt = now`, so the next tick (one `pollEveryMs` later) continues from the committed `since`/`cursor` under a fresh lease; intervals stay contiguous across ticks.
- A call in the middle of a catch-up chain throws: earlier chunks are already committed (`keepLease`), the failing chunk is not advanced, `nextAt = now + interval`, `poll.failed` names its `since`/`until`; the next tick re-covers that chunk and continues.
- `maxCallsPerTick` of `0` or a non-integer → `FlowlineDefinitionError` from `createEngine`; `maxInterval` shorter than 1 ms or longer than `MAX_DURATION_MS` → `FlowlineDefinitionError` from `defineTrigger`.
- Cursor larger than a few KB or non-JSON → `commitPoll` rejects with `FlowlineStorageError`; the engine treats it like a thrown poll (state not advanced, `poll.failed`).

## 13. Testing

- **core:** `defineTrigger` validation matrix (`event`/`events`/`normalize`/`poll`/`interval` combinations); manifest carries `events`, `interval`, `operators`.
- **nodes-builtin:** every cell of §6.3/§6.4 pinned for both modes; `createBuiltinPlugin` default propagates into the manifest schema default; custom operator lookup, arity, throwing; helpers `strictly`/`loosely`/`custom`; switch `compare`.
- **engine:** isolation (one invalid match, two valid → two started, one rejected, `onTriggerEvent` called once); dedupe window matrix (within/after window, crash recovery via `__testHooks`, concurrent deliveries, precedence table §4.4, expiry while a run waits → second run); multi-event (both events start one workflow, dedupe across events, raw event in `startedBy`, `normalize` skip/throw); poll loop (non-overlap under two engines, `since`/`until` contiguity, failure keeps `since`, item rejection isolation, lease loss aborts, crash after launch → duplicates suppressed, catch-up chunking: a 3-day gap with `maxInterval` 24h → four calls in one tick; a 30-day gap → ten calls then `nextAt === now`, next tick resumes at day 10; a throw in chunk 2 keeps chunk 1 committed).
- **storage:** conformance suites §4.6/§7.4 on memory and PGlite (and `FLOWLINE_PG_URL`); migration v4 deletes pre-v4 dedupe rows and is idempotent.
- **react:** rules widget stores typed literals; compare select toggles Match case; custom operator labels/arity; trigger card captions for multi-event and poll; origin label for poll.
- **mini-crm e2e:** "Any call ended" (AI + VoIP → two runs; duplicate call ID → one) and "Deal stuck in stage" (advance the fake clock past the threshold → run nudges; change the stage while it waits → run cancelled with reason; a deal that moved before the threshold never fires).

## 14. Out of scope (design leaves room)

- Persisting `TriggerEvent`s in storage (hosts persist them from `onTriggerEvent`).
- Pruning expired dedupe rows and orphaned poll states (small rows; a maintenance method can come later).
- "At most one active run per key" (§4.5).
- A `GET /workflows/:id/poll` route and a "last checked" panel in the editor.
- Multi-event support in `core.event` (config-declared event lists without `normalize`).
- Custom operators in switch cases; a core-validator check for rule literal types (the widget warns instead).
- Backfilling pre-v4 dedupe rows (history is reset once instead).
