# @flowlinejs/react

## 0.2.0

### Minor Changes

- c2d4951: Triggers and conditions gained five capabilities, driven by real gaps a CRM customer hit
  migrating their automations onto the library:
  
  - **Emit failure isolation.** `engine.emit(...)` no longer throws when one matching trigger
    rejects a payload; it validates and starts each match independently and resolves
    `{ started, rejected }`. Rejections (and successful starts) are also reported through the new
    `EngineOptions.onTriggerEvent`.
  - **Time-windowed dedupe.** Dedupe keys now carry a TTL instead of suppressing forever: a repeat
    delivery within the window gets the earlier run's ID back; after the window expires, the same
    key starts a fresh run with a new, always-random ID. Configure the window per call
    (`{ dedupe: { key, window } }`), per trigger (`defineTrigger({ dedupe: { key, window } })`), or
    engine-wide (`createEngine({ dedupe: { defaultWindow } })`, default 7 days).
  - **Multi-event triggers.** A trigger can listen to several events with `events: [...]` plus
    `normalize(event, payload)`, so "any call ended" or "booking cancelled, however it's reported"
    is one trigger with one dedupe namespace across its events.
  - **Condition semantics.** `core.condition` and `core.switch` support `compare: "strict" |
    "loose"`, typed literals in the rules widget, and host-registered custom operators via
    `createBuiltinPlugin({ compare?, operators? })`.
  - **Poll triggers.** `kind: "poll"` sweeps a data source over bounded, non-overlapping time
    intervals with a stored cursor and lease, starting one run per due item — for domain sweeps like
    "deal stuck in a stage for N days" that a cron or a delayed step can't express correctly.
  
  See `docs/superpowers/specs/2026-09-28-flowline-triggers-conditions-design.md` for the full design.
  
  ### Behavior changes
  
  - Loose `contains`/`notContains`/`startsWith`/`endsWith` now stringify a non-string left operand
    before comparing, e.g. `12345 contains "23"` is now `true` (previously `false`, since a
    non-string left never matched).
  - Dedupe keys now expire after a window (default 7 days) instead of suppressing duplicates
    permanently; a delivery after the window starts a new run with a fresh ID even if an earlier run
    with that key is still active.
  - Run IDs are always a random `run_<32 hex>` from `crypto.randomUUID()`, never derived from a
    dedupe key; don't rely on a run ID being predictable from its key.
  - `engine.emit(...)` resolves `{ started, rejected }` and never throws `FlowlineValidationError`
    for an invalid match; read `result.rejected` (or subscribe to `onTriggerEvent`) instead of
    catching.
  - `emit(..., { dedupeKey })` / `start({ dedupeKey })` are renamed to
    `{ dedupe: { key, window? } }`; `defineTrigger({ dedupeKey })` is renamed to
    `defineTrigger({ dedupe: { key, window? } })`, whose `key` now also receives the delivered
    `event`.
  - `StorageAdapter.recordDedupeKey` is removed, replaced by `claimDedupeKey` (atomic
    insert-or-get, returns the claimed run ID) plus the new poll-state methods (`claimPoll`,
    `renewPollLease`, `commitPoll`, `getPollState`). Third-party storage adapters must implement the
    new methods and re-run the conformance suite.
  - Postgres schema moves to v4: `dedupe_keys` gains a required `run_id` and every pre-v4 row is
    deleted, so dedupe history is reset once on upgrade from 0.1.0 (there is no backfill; a
    retried event inside its old window may start a second run once). A new `poll_states` table is
    added. Stop workers, run `migrate()`, then start upgraded workers.
  - `builtinPlugin` is unchanged, but hosts wanting a strict default or custom operators now use
    `createBuiltinPlugin({ compare?, operators? })` in their own registry instead.
  - `TriggerKind` and `RunOrigin` gain a `"poll"` variant; an exhaustive `switch` on either needs a
    new case.

### Patch Changes

- Updated dependencies [c2d4951]
  - @flowlinejs/core@0.2.0
