// A named import (no `with { type: "json" }`) lets esbuild/Rollup tree-shake the JSON module
// down to this one property, so the bundled dist doesn't ship the rest of package.json
// (scripts, devDependencies, ...). See packages/engine/src/index.test.ts.
import { version } from "../package.json";

/** Package version, read from `package.json` so it can never drift from the published version. */
export const VERSION: string = version;

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
