/**
 * Engine error classes. Node handlers throw {@link RetryableError} or {@link FatalError} to control
 * retry behaviour (any other error is treated as retryable); storage adapters throw
 * {@link FlowkitStorageError} for contract violations.
 *
 * @module
 */

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
