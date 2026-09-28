/**
 * Small helpers shared by the engine modules.
 *
 * @internal
 * @module
 */

/** @internal Path the HTTP handler is mounted under unless `basePath` says otherwise. */
export const DEFAULT_BASE_PATH = "/flowkit";

/** @internal Whether `v` is a non-null, non-array object. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** @internal The message of an error, or the thrown value as a string. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
