/**
 * The storage contract the engine runs on. Every adapter (memory, Postgres, third-party) must
 * implement {@link StorageAdapter} exactly as documented here and pass
 * `runStorageConformance` from `@flowkit/engine/testing`.
 *
 * All timestamps are epoch milliseconds. Storage never reads a clock: every method that needs the
 * current time receives it as `now`.
 *
 * @module
 */
import type {
  JournalEntry,
  ResumeInfo,
  RunError,
  RunEvent,
  RunOrigin,
  RunStatus,
  RunSummary,
  WorkflowDoc,
  WorkflowSummary,
  WorkflowVersion,
} from "@flowkit/core";

/**
 * Why a `waiting` run is waiting:
 * - `retry`: a step failed retryably; the run wakes at `wakeAt` to retry it.
 * - `timer`: a step suspended until `wakeAt`.
 * - `callback`: a step waits for its callback token (and times out at `wakeAt`, if set).
 * - `subflow`: a step waits for a child run to wake it (`wakeParent`).
 */
export type WaitReason = "retry" | "timer" | "callback" | "subflow";

/** The durable state of one workflow run, as stored. */
export interface Run {
  /** Globally unique run ID, chosen by the caller of {@link StorageAdapter.createRun}. */
  id: string;
  /** Owning tenant. */
  tenantId: string;
  /** Workflow the run executes. */
  workflowId: string;
  /** Pinned workflow version. */
  version: number;
  /** Lifecycle state. */
  status: RunStatus;
  /** Trigger payload. */
  trigger: unknown;
  /** Step journal keyed by step path. */
  journal: Record<string, JournalEntry>;
  /** Attempt number of the current step (1-based). */
  attempt: number;
  /** Path of the step being executed or waited on. */
  currentStep?: string;
  /** For `waiting` runs: when the run becomes claimable again. */
  wakeAt?: number;
  /** For `waiting` runs: what the run is waiting for. */
  waitReason?: WaitReason;
  /** Single-use token that resumes the run via {@link StorageAdapter.resumeByToken}. */
  callbackToken?: string;
  /** When {@link Run.callbackToken} stops being accepted. */
  callbackExpiresAt?: number;
  /** Why the run was resumed; handed to the suspended handler as `ctx.resume`. */
  resume?: ResumeInfo;
  /** For sub-flow runs: the parent run and the parent step waiting on this run. */
  parent?: { runId: string; stepPath: string };
  /** Workflow output mapping result (sub-flows). */
  output?: unknown;
  /** Failure details. */
  error?: RunError;
  /** What started the run. */
  startedBy: RunOrigin;
  /** Worker currently holding the lease, if any. */
  leaseOwner?: string;
  /** When the current lease expires. */
  leaseUntil?: number;
  /** Creation time (set by storage). */
  createdAt: number;
  /** Last write time (set by storage on every successful write). */
  updatedAt: number;
}

/** The input of {@link StorageAdapter.createRun} and {@link RunPatch.createChild}. */
export type NewRun = Omit<Run, "createdAt" | "updatedAt">;

/**
 * Exclusive permission to advance a run, returned by {@link StorageAdapter.claimRun}.
 * The `token` is opaque; it stays current until the run is released, claimed again by anyone
 * (after expiry), or modified by {@link StorageAdapter.updateRunUnleased}.
 */
export interface Lease {
  /** Snapshot of the run as claimed (status `running`, lease fields set). */
  run: Run;
  /** Opaque lease token; every guarded write compares it against the stored token. */
  token: string;
}

/**
 * A partial update of a run. Omitted (`undefined`) fields are left unchanged; `null` clears an
 * optional field.
 */
export interface RunPatch {
  /** New status. */
  status?: RunStatus;
  /** Merged into the journal by key; a `null` value deletes that key. */
  journal?: Record<string, JournalEntry | null>;
  /** New attempt number. */
  attempt?: number;
  /** New current step; `null` clears. */
  currentStep?: string | null;
  /** New wake time; `null` clears. */
  wakeAt?: number | null;
  /** New wait reason; `null` clears. */
  waitReason?: WaitReason | null;
  /** New callback token; `null` clears. */
  callbackToken?: string | null;
  /** New callback expiry; `null` clears. */
  callbackExpiresAt?: number | null;
  /** New resume info; `null` clears. */
  resume?: ResumeInfo | null;
  /** New output (any value other than `undefined` is stored). */
  output?: unknown;
  /** New error; `null` clears. */
  error?: RunError | null;
  /** Clear the lease (`leaseOwner`, `leaseUntil` and the lease token) in the same write. */
  release?: boolean;
  /**
   * Wake a parent run in the SAME atomic write. Applied only when the parent exists, has status
   * `waiting` and `currentStep === stepPath`; it then becomes `queued` with `resume` set,
   * `wakeAt`/`callbackToken`/`callbackExpiresAt` cleared (`waitReason` is kept). Otherwise the
   * parent is left untouched and the write still succeeds.
   */
  wakeParent?: { runId: string; stepPath: string; resume: ResumeInfo };
  /**
   * Insert a child run in the SAME atomic write (`createdAt`/`updatedAt` = `now`). Idempotent on
   * the child's `id`: when a run with that id already exists, nothing is inserted and the write
   * still succeeds.
   */
  createChild?: NewRun;
}

/** An event to append; storage assigns `id` and `seq`. */
export type NewRunEvent = Omit<RunEvent, "id" | "seq">;

/** An audit record of a workflow save or publish. */
export interface WorkflowAuditEntry {
  /** Owning tenant. */
  tenantId: string;
  /** Workflow ID. */
  workflowId: string;
  /** Version saved or published. */
  version: number;
  /** What happened. */
  action: "saved" | "published";
  /** User ID that performed it. */
  actor: string;
  /** When it happened. */
  at: number;
}

/**
 * Persistence for workflow versions, runs, events and dedupe keys.
 *
 * General rules every adapter must follow:
 * - **Isolation:** values passed in and values returned are never shared with storage state;
 *   mutating either afterwards must not change what is stored.
 * - **Tenancy:** every method taking a `tenantId` only sees that tenant's data; a record of another
 *   tenant behaves exactly as if it did not exist. Run IDs are nevertheless globally unique.
 * - **Atomicity:** each method is one atomic operation. Guarded writes (`commit`, `renewLease`,
 *   `resumeByToken`, `resumeRun`, `updateRunUnleased`, `claimRun`) check their condition and write
 *   in the same transaction, so concurrent callers (in any number of processes) can never both
 *   succeed on the same precondition. A write that returns `false`/`null` changes nothing.
 * - **Events:** storage assigns each appended event a unique `id` and a `seq` that is strictly
 *   increasing per run (starting at 1 for the run's first event), across all methods that append.
 * - **Times:** storage never reads a clock; `updatedAt` is set to the `now` argument of the write.
 * - **Lease token:** the token is internal state, never part of a returned {@link Run}.
 */
export interface StorageAdapter {
  /**
   * Store `doc` as the next version of workflow `doc.id` for the tenant: version 1 for a new
   * workflow, otherwise the highest existing version + 1. Versions are immutable once saved.
   * Does not write an audit entry (see {@link StorageAdapter.appendWorkflowAudit}).
   * Concurrent saves of the same workflow must get distinct version numbers.
   */
  saveWorkflowVersion(
    tenantId: string,
    doc: WorkflowDoc,
    actor: string,
    now: number,
  ): Promise<WorkflowVersion>;

  /** A specific version, or `null` if it does not exist. */
  getWorkflowVersion(
    tenantId: string,
    workflowId: string,
    version: number,
  ): Promise<WorkflowVersion | null>;

  /** The highest-numbered version, or `null` if the workflow has none. */
  getLatestVersion(tenantId: string, workflowId: string): Promise<WorkflowVersion | null>;

  /** The currently published version, or `null` if none is published. */
  getPublishedVersion(tenantId: string, workflowId: string): Promise<WorkflowVersion | null>;

  /**
   * Mark `version` as the workflow's published version (replacing any previous one) and record
   * `now` as its `publishedAt`. Rejects with an `Error` if the version does not exist.
   * Does not write an audit entry.
   */
  publishVersion(tenantId: string, workflowId: string, version: number, now: number): Promise<void>;

  /**
   * One summary per workflow of the tenant, ordered by workflow ID ascending. `name` and
   * `triggerType` come from the latest version; `updatedAt` is the latest version's `createdAt`;
   * `publishedVersion`/`publishedAt` are `null` when nothing is published.
   */
  listWorkflows(tenantId: string): Promise<WorkflowSummary[]>;

  /**
   * The published version of every workflow that has one, optionally restricted to a tenant and/or
   * to published versions whose `doc.trigger.type === triggerType`. Unfiltered calls span all
   * tenants (used by workers to find schedule/event workflows). Order is unspecified.
   */
  listPublished(filter: { tenantId?: string; triggerType?: string }): Promise<WorkflowVersion[]>;

  /** Append a workflow audit entry. */
  appendWorkflowAudit(e: WorkflowAuditEntry): Promise<void>;

  /** All audit entries of a workflow, in append order. */
  listWorkflowAudit(tenantId: string, workflowId: string): Promise<WorkflowAuditEntry[]>;

  /**
   * Insert a run with `createdAt = updatedAt = now` and append `events` (seq 1, 2, ...) in one
   * atomic write. Lease fields on the input are ignored (a new run is never leased).
   *
   * Idempotent: if a run with `run.id` already exists (in any tenant), returns the existing run
   * unchanged and appends nothing.
   */
  createRun(run: NewRun, events: NewRunEvent[], now: number): Promise<Run>;

  /** A run of the tenant, or `null`. */
  getRun(tenantId: string, runId: string): Promise<Run | null>;

  /** A run by ID regardless of tenant, or `null`. Internal use only (e.g. parent wake-up). */
  getRunById(runId: string): Promise<Run | null>;

  /**
   * Summaries of the tenant's runs, newest first (`createdAt` descending, then `id` descending),
   * optionally filtered by workflow and/or status, at most `limit` rows (default 50).
   */
  listRuns(
    tenantId: string,
    f: { workflowId?: string; status?: RunStatus; limit?: number },
  ): Promise<RunSummary[]>;

  /**
   * Atomically lease one runnable run (across all tenants), or return `null` if none is eligible.
   *
   * Eligible: `status === "queued"`; or `status === "waiting"` with `wakeAt <= now` (a waiting run
   * without `wakeAt` is never claimable); or `status === "running"` whose lease expired
   * (`leaseUntil < now`, or no `leaseUntil`). Among eligible runs, the one with the smallest
   * `wakeAt ?? updatedAt` is chosen (ties: `createdAt`, then `id`, ascending), so overdue timers are
   * not starved by newer queued runs.
   *
   * The claimed run gets `status: "running"`, `leaseOwner = workerId`, `leaseUntil = now + leaseMs`,
   * `updatedAt = now` and a fresh lease token (which invalidates any previous token); all other
   * fields are unchanged. Concurrent claimers must never receive the same run while its lease is
   * unexpired.
   */
  claimRun(opts: { workerId: string; leaseMs: number; now: number }): Promise<Lease | null>;

  /**
   * Extend the lease to `now + leaseMs` if `lease.token` is still the run's current token.
   * Returns `false` (and writes nothing) otherwise. An expired lease whose token is still current
   * (nobody reclaimed the run) may be renewed.
   */
  renewLease(lease: Lease, leaseMs: number, now: number): Promise<boolean>;

  /**
   * Apply `patch` to the leased run, insert `patch.createChild`, apply `patch.wakeParent` and
   * append `events` — all in ONE atomic write, guarded by the lease token.
   *
   * Returns `false` and changes NOTHING (no journal merge, no child, no parent wake, no events) if
   * `lease.token` is no longer the run's current token. A token stays current until the run is
   * released, reclaimed, or modified by `updateRunUnleased`; mere expiry does not invalidate it.
   *
   * On success `updatedAt = now`; without `patch.release` the lease is kept (same token), with it
   * `leaseOwner`, `leaseUntil` and the token are cleared. Events may belong to any run (e.g. the
   * child's `run.started`) and get per-run `seq` numbers.
   */
  commit(lease: Lease, patch: RunPatch, events: NewRunEvent[], now: number): Promise<boolean>;

  /**
   * Resume the `waiting` run whose `callbackToken === token`, provided the token has not expired
   * (`callbackExpiresAt` unset or `> now`). The run becomes `queued` with `resume` set and
   * `callbackToken`, `callbackExpiresAt` and `wakeAt` cleared (`waitReason` kept), so the token
   * is single use. Returns the updated run, or `null` (no write) when no run matches.
   */
  resumeByToken(token: string, resume: ResumeInfo, now: number): Promise<Run | null>;

  /**
   * Resume run `runId` if it is `waiting` with `currentStep === expectCurrentStep`, with the same
   * transition as {@link StorageAdapter.resumeByToken}. Returns whether it was resumed.
   */
  resumeRun(
    runId: string,
    expectCurrentStep: string,
    resume: ResumeInfo,
    now: number,
  ): Promise<boolean>;

  /**
   * Apply `patch` (including `createChild` and `wakeParent`) and append `events` atomically to a
   * run that is NOT currently leased — i.e. it has no lease, or `leaseUntil < now`. Used for
   * cancel/retry of runs no worker is executing. Any stale lease is cleared (invalidating its
   * token), whether or not `patch.release` is set.
   *
   * Returns `false` (no write) if the run does not exist in the tenant or holds an unexpired lease
   * (`leaseUntil >= now`).
   */
  updateRunUnleased(
    tenantId: string,
    runId: string,
    patch: RunPatch,
    events: NewRunEvent[],
    now: number,
  ): Promise<boolean>;

  /** Append events outside of a run write, assigning `id` and per-run `seq`. */
  appendEvents(events: NewRunEvent[]): Promise<void>;

  /** All events of a run of the tenant, ordered by `seq` ascending (empty if none/not found). */
  listEvents(tenantId: string, runId: string): Promise<RunEvent[]>;

  /**
   * Record `key` for the tenant until `now + ttlMs`. Returns `true` if it was newly recorded (absent
   * or expired, i.e. its previous expiry `<= now`), `false` if an unexpired record exists (which is
   * then left unchanged). Atomic: of concurrent calls with the same key, exactly one gets `true`.
   */
  recordDedupeKey(tenantId: string, key: string, now: number, ttlMs: number): Promise<boolean>;
}
