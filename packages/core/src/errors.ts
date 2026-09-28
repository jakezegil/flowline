/**
 * Error classes node handlers throw to control retry behaviour: {@link RetryableError} retries the
 * step according to its retry policy, {@link FatalError} fails it at once. Any other error is
 * treated as retryable. They live in core so plugins can throw them without depending on the
 * engine; `@flowlinejs/engine` re-exports them.
 *
 * @module
 */

/** A transient failure: the engine retries the step according to its retry policy. */
export class RetryableError extends Error {
  /** Error name, for `instanceof`-free checks across package copies. */
  override readonly name: string = "RetryableError";
}

/** Options of {@link FatalError}. */
export interface FatalErrorOptions extends ErrorOptions {
  /** Machine-readable error code, copied into the run's error. */
  code?: string;
}

/** A permanent failure: the step fails immediately without retries. */
export class FatalError extends Error {
  /** Error name, for `instanceof`-free checks across package copies. */
  override readonly name: string = "FatalError";
  /** Machine-readable error code, if any. */
  code?: string;

  /**
   * @param message Human-readable message.
   * @param options Standard error options plus an optional `code`.
   */
  constructor(message?: string, options?: FatalErrorOptions) {
    super(message, options);
    if (options?.code !== undefined) this.code = options.code;
  }
}
