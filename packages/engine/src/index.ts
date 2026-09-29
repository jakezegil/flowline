import pkg from "../package.json" with { type: "json" };

/** Package version, read from `package.json` so it can never drift from the published version. */
export const VERSION: string = pkg.version;

export {
  type CancelRunOptions,
  createEngine,
  type Engine,
  type EngineOptions,
  type ResumeRunOptions,
} from "./engine";
export {
  FatalError,
  type FatalErrorOptions,
  FlowlineStorageError,
  FlowlineValidationError,
  ResumeHostHandledError,
  ResumeUnverifiableError,
  RetryableError,
  WorkflowExistsError,
} from "./errors";
export { buildScope, type Frame, type NextAction, nextAction } from "./interpreter";
export {
  type CancelRequest,
  type DedupeClaim,
  type Lease,
  type ListRunsFilter,
  type NewRun,
  type NewRunEvent,
  type PollLease,
  type PollPatch,
  type PollState,
  type ResumeEvent,
  type Run,
  type RunPatch,
  type StorageAdapter,
  stoppedAtOf,
  type WaitReason,
  type WorkflowAuditEntry,
} from "./storage";
export { type QuickjsRuntimeOptions, quickjsRuntime } from "./transform/quickjs";
export type { TriggerEvent } from "./trigger-events";
export type { DedupeOptions, EmitRejection, EmitResult } from "./triggers";
export type { Worker, WorkerOptions } from "./worker";
