/**
 * HTTP request/response DTOs shared by the engine's HTTP handler and the client
 * (`@flowlinejs/core/client`). All timestamps are epoch milliseconds.
 *
 * Routes (relative to the handler's base path):
 * - `GET  /manifest` → `Manifest`
 * - `GET  /workflows` → {@link WorkflowSummary}[]
 * - `GET  /workflows/:id` → {@link WorkflowDetail}
 * - `PUT  /workflows/:id?create=true` body {@link WorkflowDoc} → {@link WorkflowVersion} (with
 *   `create=true`, only for a new workflow: 409 `{ code: "workflow_exists" }` otherwise)
 * - `POST /workflows/:id/publish` body {@link PublishRequest} → 2xx (422 `{ issues }` when invalid)
 * - `POST /workflows/validate` body {@link WorkflowDoc} → `Issue[]`
 * - `POST /workflows/:id/test-step` body {@link TestStepRequest} → {@link TestStepResponse}
 * - `POST /workflows/:id/run` body {@link RunWorkflowRequest} → {@link RunStartedResponse}
 * - `GET  /runs?workflowId&status&topLevel&stopped&limit` → {@link RunSummary}[] (`topLevel=true`
 *   leaves out sub-flow runs; `stopped=true|false` keeps only, or leaves out, runs a Stop ended)
 * - `GET  /runs/:id` → {@link RunDetail}
 * - `POST /runs/:id/retry` → {@link RunStartedResponse} (409 when the run is not failed)
 * - `POST /runs/:id/cancel` → 200 cancelled, 202 cancellation requested, 409 `{ error: "finished" }`
 * - `POST /runs/:id/resume?step=<stepPath>` body = callback body → 202 (410 `{ error: "gone" }`
 *   when not waiting on a callback, or, with `step`, not waiting at that step; 409
 *   `{ code: "resume_host_handled" | "resume_unverifiable" }`; 400 when the body doesn't match
 *   the node's `resume.body`)
 * - `GET  /runs/:id/stream?after=<seq>` → `text/event-stream` of `event: run`, `id: <seq>`,
 *   `data: <RunEvent JSON>` frames; ends once the run's latest event is
 *   `run.completed|failed|cancelled|stopped` (a retried run's earlier `run.failed` does not end it)
 * - `GET  /secrets` → `string[]` (secret names only)
 * - `GET  /subflows` → {@link SubflowInfo}[]
 *
 * Public routes (no `authorize`):
 * - `POST /hooks/:tenantId/:workflowId/:slug` body = JSON → 202 {@link RunStartedResponse}
 *   (200 `{ runId, deduped: true }` for a repeated dedupe header or trigger `dedupe.key` within its window; 200
 *   `{ skipped: true }` when the trigger's `filter` returns `false`; 404 for an unknown slug, 401
 *   for a bad `X-Flowline-Signature`, 400 `{ issues }` for a body not matching the declared
 *   fields). The signature has no timestamp, so a captured delivery can be replayed: set a
 *   dedupe header (e.g. the sender's delivery id) alongside a signing secret.
 * - `POST /resume/:token` body = callback body → 202 (410 `{ error: "gone" }`; 409
 *   `{ code: "resume_unverifiable" }` when the waiting step can't be checked; 400 when the body
 *   doesn't match the node's `resume.body`)
 *
 * Editor requests other than `GET` must send `Content-Type: application/json`, bodyless ones
 * (cancel, retry) too; anything else, including no `Content-Type`, is refused with 415 (so a
 * cross-site form or no-cors fetch cannot reach them).
 * Validation failures of run input are 400 `{ error, issues }`. Error responses are JSON
 * {@link ApiErrorBody}.
 *
 * @module
 */
import type { DurationInput, JSONSchema, Step, WorkflowDoc } from "./types";

/** One row of `GET /workflows`. */
export interface WorkflowSummary {
  /** Workflow ID. */
  id: string;
  /** Display name (from the latest version). */
  name: string;
  /** Trigger type of the latest version. */
  triggerType: string;
  /** Highest saved version number. */
  latestVersion: number;
  /** Currently published version, if any. */
  publishedVersion: number | null;
  /** When the published version was published. */
  publishedAt: number | null;
  /** When the latest version was saved. */
  updatedAt: number;
}

/** An immutable saved version of a workflow document. */
export interface WorkflowVersion {
  /** Workflow ID. */
  workflowId: string;
  /** Owning tenant. */
  tenantId: string;
  /** Version number, starting at 1. */
  version: number;
  /** The document as saved. */
  doc: WorkflowDoc;
  /** User ID of the saver. */
  createdBy: string;
  /** Save time. */
  createdAt: number;
}

/** Response of `GET /workflows/:id`. */
export interface WorkflowDetail {
  /** The most recently saved version. */
  latest: WorkflowVersion;
  /** The published version, if any. */
  published: WorkflowVersion | null;
}

/** Lifecycle state of a run. */
export type RunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";

/**
 * The journaled state of one step execution, keyed by step path in {@link RunDetail}.
 * Never contains callback tokens or resume URLs.
 */
export type JournalEntry =
  | {
      status: "done";
      output: unknown;
      branch?: string;
      at: number;
      startedAt: number;
      attempts: number;
      input?: unknown;
    }
  | {
      status: "branched";
      output: unknown;
      branch: string;
      at: number;
      startedAt: number;
      attempts: number;
      input?: unknown;
    }
  | {
      status: "looping";
      items: unknown[];
      results: unknown[];
      at: number;
      startedAt: number;
      /** Attempts the loop handler took to produce its items; copied to the final `done` entry. */
      attempts: number;
      input?: unknown;
    }
  | {
      status: "suspended";
      pending?: { hasCallback?: boolean; expiresAt?: number; until?: number; childRunId?: string };
      at: number;
      startedAt: number;
      attempts: number;
      input?: unknown;
    }
  | { status: "skipped"; at: number }
  | {
      status: "failed";
      error: RunError;
      at: number;
      startedAt: number;
      attempts: number;
      input?: unknown;
    };

/** Why a run or step failed. */
export interface RunError {
  /** Human-readable message. */
  message: string;
  /** Machine-readable code, if any. */
  code?: string;
  /** Path of the failing step. */
  stepPath?: string;
  /** Whether the failure was non-retryable. */
  fatal?: boolean;
}

/** What started a run. */
export type RunOrigin =
  | { kind: "event"; event: string }
  | { kind: "webhook" }
  | { kind: "manual"; userId?: string }
  | { kind: "schedule"; fireAt: number }
  | { kind: "subflow"; parentRunId: string; parentStepPath: string }
  /** One item of a poll trigger, found in the interval `(since, until]` (epoch ms). */
  | { kind: "poll"; since: number; until: number; itemKey: string };

/** One row of `GET /runs`. */
export interface RunSummary {
  /** Run ID. */
  id: string;
  /** Workflow the run belongs to. */
  workflowId: string;
  /** Pinned workflow version. */
  version: number;
  /** Current state. */
  status: RunStatus;
  /** Creation time. */
  createdAt: number;
  /** Last state change. */
  updatedAt: number;
  /** Failure details when `status` is `failed`. */
  error?: RunError;
  /** What started the run. */
  startedBy: RunOrigin;
  /**
   * For a run that a Stop step (`core.stop`) ended early: the path of that step. The run's
   * `status` is `completed`; this tells it apart from a run that reached its end.
   */
  stoppedAt?: string;
}

/** Types of audit events recorded for a run. */
export type RunEventType =
  | "run.started"
  | "step.started"
  | "step.completed"
  | "step.failed"
  | "step.retrying"
  | "step.skipped"
  /** A suspended step's `afterCommit` (e.g. a callback notification) failed; the run keeps waiting. */
  | "step.afterCommitFailed"
  | "run.suspended"
  | "run.resumed"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "run.stopped";

/** An append-only audit event of a run, ordered by `seq`. */
export interface RunEvent {
  /** Event ID. */
  id: string;
  /** Run the event belongs to. */
  runId: string;
  /** Owning tenant. */
  tenantId: string;
  /** Per-run sequence number, strictly increasing. */
  seq: number;
  /** Event type. */
  type: RunEventType;
  /** Step the event concerns, if any. */
  stepPath?: string;
  /** Event time. */
  at: number;
  /** Worker that produced it. */
  workerId?: string;
  /** Event-specific details (redacted). */
  data?: unknown;
}

/** Response of `GET /runs/:id`. */
export interface RunDetail {
  /** The run with its trigger payload, journal and output. */
  run: RunSummary & {
    /** Trigger payload. */
    trigger: unknown;
    /** Step journal keyed by step path. */
    journal: Record<string, JournalEntry>;
    /** Workflow output mapping result, for completed sub-flows. */
    output?: unknown;
    /** When a waiting run will next wake. */
    wakeAt?: number;
    /** For sub-flow runs: the parent run and step. */
    parent?: { runId: string; stepPath: string };
  };
  /** All events of the run, ordered by `seq`. */
  events: RunEvent[];
  /** The pinned workflow document. */
  doc: WorkflowDoc;
}

/** Body of `POST /workflows/:id/test-step`: run one step against sample data, without journaling. */
export interface TestStepRequest {
  /** The step to run. */
  step: Step;
  /** The (possibly unsaved) document containing the step. */
  doc: WorkflowDoc;
  /** Sample outputs of earlier steps, keyed by step ID. */
  samples: Record<string, unknown>;
  /** Sample trigger payload. */
  triggerSample?: unknown;
}

/** Response of `POST /workflows/:id/test-step`. */
export interface TestStepResponse {
  /** Whether the handler succeeded. */
  ok: boolean;
  /** The handler's output. */
  output?: unknown;
  /** Branch chosen by a branching node. */
  branch?: string;
  /** Control-flow signal returned (reported, not executed). */
  signal?: "suspend" | "stop" | "subflow";
  /** Error message when `ok` is false. */
  error?: string;
  /** The resolved input the handler received. */
  input?: unknown;
  /** Handler wall-clock time. */
  durationMs: number;
}

/** One row of `GET /subflows`: a published workflow callable as a sub-flow. */
export interface SubflowInfo {
  /** Workflow ID. */
  id: string;
  /** Display name. */
  name: string;
  /** JSON Schema of the sub-flow's input (its trigger payload). */
  input: JSONSchema;
  /** JSON Schema of the sub-flow's output. */
  output: JSONSchema;
}

/** Body of `POST /workflows/:id/publish`. */
export interface PublishRequest {
  /** Version to publish. */
  version: number;
}

/** Body of `POST /workflows/:id/run` (manual trigger). */
export interface RunWorkflowRequest {
  /** Trigger payload for the run. */
  input?: unknown;
  /**
   * Repeated requests with the same `key` within `window` (whole ms or a duration such as
   * `"30m"`; default the engine's `dedupe.defaultWindow`, 7 days unless configured) start one
   * run and all answer its `runId`. An invalid window is a 400.
   */
  dedupe?: { key?: string; window?: DurationInput };
}

/** Response of routes that start a run (`/workflows/:id/run`, `/runs/:id/retry`). */
export interface RunStartedResponse {
  /** ID of the started run. */
  runId: string;
}

/** JSON body of every error response. */
export interface ApiErrorBody {
  /** Error message. */
  error: string;
  /** Validation issues, e.g. for a rejected publish (422). */
  issues?: unknown[];
  /**
   * Machine-readable reason, where one is defined: `"resume_host_handled"` (409 from
   * `POST /runs/:id/resume` for a step the host app resumes itself), `"resume_unverifiable"` (409:
   * the waiting step's node or version is missing) or `"workflow_exists"` (409 from
   * `PUT /workflows/:id?create=true`).
   */
  code?: string;
}
