/** Package version. */
export const VERSION = "0.1.0";

export { FatalError, type FatalErrorOptions, RetryableError } from "./errors";
export type {
  Lease,
  NewRun,
  NewRunEvent,
  Run,
  RunPatch,
  StorageAdapter,
  WaitReason,
  WorkflowAuditEntry,
} from "./storage";
