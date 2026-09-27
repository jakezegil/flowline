/**
 * Errors a node handler can throw to control retry behaviour. Any other error is treated as
 * retryable.
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
