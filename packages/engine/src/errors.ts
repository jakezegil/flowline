/**
 * Engine error classes. Node handlers throw {@link RetryableError} or {@link FatalError} to control
 * retry behaviour (any other error is treated as retryable); storage adapters throw
 * {@link FlowkitStorageError} for contract violations; the engine API throws
 * {@link FlowkitValidationError} for rejected workflows, payloads and inputs.
 *
 * @module
 */
import type { Issue } from "@flowkit/core";

export { FatalError, type FatalErrorOptions, RetryableError } from "@flowkit/core";

/**
 * A storage operation violated a storage invariant, e.g. creating a run whose ID already belongs
 * to another tenant. Thrown (rejected) by `StorageAdapter` methods; the operation wrote
 * nothing.
 */
export class FlowkitStorageError extends Error {
  /** Error name, for `instanceof`-free checks across package copies. */
  override readonly name: string = "FlowkitStorageError";
}

/**
 * A workflow, trigger payload or run input was rejected by validation; nothing was written.
 * `issues` lists the problems. The HTTP handler answers with 400 (422 for a rejected publish) and
 * `{ error, issues }`.
 */
export class FlowkitValidationError extends Error {
  /** Error name, for `instanceof`-free checks across package copies. */
  override readonly name: string = "FlowkitValidationError";
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
