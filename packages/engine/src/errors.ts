/**
 * Engine error classes. Node handlers throw {@link RetryableError} or {@link FatalError} to control
 * retry behaviour (any other error is treated as retryable); storage adapters throw
 * {@link FlowlineStorageError} for contract violations; the engine API throws
 * {@link FlowlineValidationError} for rejected workflows, payloads and inputs.
 *
 * @module
 */
import type { Issue } from "@flowlinejs/core";

export { FatalError, type FatalErrorOptions, RetryableError } from "@flowlinejs/core";

/**
 * A storage operation violated a storage invariant, e.g. creating a run whose ID already belongs
 * to another tenant. Thrown (rejected) by `StorageAdapter` methods; the operation wrote
 * nothing.
 */
export class FlowlineStorageError extends Error {
  /** Error name, for `instanceof`-free checks across package copies. */
  override readonly name: string = "FlowlineStorageError";
}

/**
 * A workflow, trigger payload or run input was rejected by validation; nothing was written.
 * `issues` lists the problems. The HTTP handler answers with 400 (422 for a rejected publish) and
 * `{ error, issues }`.
 */
export class FlowlineValidationError extends Error {
  /** Error name, for `instanceof`-free checks across package copies. */
  override readonly name: string = "FlowlineValidationError";
  /** What is wrong. */
  readonly issues: Issue[];

  /**
   * @param message Summary of the problem.
   * @param issues The individual problems.
   */
  constructor(message: string, issues: Issue[]) {
    super(message);
    this.issues = issues;
  }
}

/**
 * @internal The engine refused an operation because of its target's current state (e.g. retrying
 * a run that is not failed). The HTTP handler answers 409.
 */
export class EngineConflictError extends Error {
  override readonly name: string = "EngineConflictError";
}

/** @internal An engine call named something that does not exist. The HTTP handler answers 404. */
export class EngineNotFoundError extends Error {
  override readonly name: string = "EngineNotFoundError";
}

/**
 * `resumeRun` with `refuseHostHandled` found the run waiting on a step whose node declares
 * `resume.hostHandled`: the host app resumes it (e.g. from its approvals page, which checks who
 * may decide), not the generic resume route. The HTTP handler answers 409 with
 * `code: "resume_host_handled"`.
 */
export class ResumeHostHandledError extends Error {
  /** Error name, for `instanceof`-free checks across package copies. */
  override readonly name: string = "ResumeHostHandledError";
  /** Machine-readable code, also sent by the HTTP handler. */
  readonly code = "resume_host_handled";
}

/**
 * A resume was refused because the engine could not check it against the waiting step's
 * declaration: the run's pinned version, the waiting step or its node type is missing. The check
 * fails closed. The HTTP handler answers 409 with `code: "resume_unverifiable"`.
 */
export class ResumeUnverifiableError extends Error {
  /** Error name, for `instanceof`-free checks across package copies. */
  override readonly name: string = "ResumeUnverifiableError";
  /** Machine-readable code, also sent by the HTTP handler. */
  readonly code = "resume_unverifiable";
}

/**
 * `saveWorkflow` with `create` found that the workflow already exists; nothing was saved. The
 * HTTP handler answers 409 with `code: "workflow_exists"`.
 */
export class WorkflowExistsError extends Error {
  /** Error name, for `instanceof`-free checks across package copies. */
  override readonly name: string = "WorkflowExistsError";
  /** Machine-readable code, also sent by the HTTP handler. */
  readonly code = "workflow_exists";
}
