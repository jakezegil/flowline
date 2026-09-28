/** Package version. */
export const VERSION = "0.1.0";

export { createEngine, type Engine, type EngineOptions } from "./engine";
export {
  FatalError,
  type FatalErrorOptions,
  FlowkitStorageError,
  RetryableError,
} from "./errors";
export { buildScope, type Frame, type NextAction, nextAction } from "./interpreter";
export type {
  Lease,
  NewRun,
  NewRunEvent,
  ResumeEvent,
  Run,
  RunPatch,
  StorageAdapter,
  WaitReason,
  WorkflowAuditEntry,
} from "./storage";
export { type QuickjsRuntimeOptions, quickjsRuntime } from "./transform/quickjs";
