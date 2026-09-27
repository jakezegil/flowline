/**
 * Internal step-ID rules shared by the builder, validator and tree operations.
 *
 * @module
 */

/** Step ID grammar. */
export const STEP_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * IDs that match the grammar but are rejected: `__proto__`, `constructor` and `prototype`
 * collide with special object properties when used as keys (journals, scopes), and `__trigger`
 * is the editor's key for the trigger (selection, samples).
 */
export const RESERVED_STEP_IDS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "__trigger",
]);

/** Whether `id` is a valid step ID: matches {@link STEP_ID_PATTERN} and is not reserved. */
export function isValidStepId(id: unknown): id is string {
  return typeof id === "string" && STEP_ID_PATTERN.test(id) && !RESERVED_STEP_IDS.has(id);
}
