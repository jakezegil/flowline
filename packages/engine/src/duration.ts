/**
 * Parsing durations given as {@link DurationInput}: dedupe windows and poll intervals.
 *
 * @module
 */
import type { DurationInput } from "@flowlinejs/core";
import { MAX_DURATION_MS, parseDuration } from "@flowlinejs/nodes-builtin";
import { FlowlineValidationError } from "./errors";

/**
 * @internal The duration in ms: `input` as whole milliseconds, or duration text such as `"30m"`
 * (see `parseDuration`); `fallbackMs` when `input` is `undefined`. `what` names the value in the
 * error message (default `"Dedupe window"`).
 *
 * @throws {@link FlowlineValidationError} if `input` is shorter than 1 ms, longer than
 * `MAX_DURATION_MS` (365 days), not a whole number of ms, or unparsable text. A window of 0 would
 * expire at the moment it is claimed, so a concurrent duplicate could claim it again.
 */
export function parseWindow(
  input: DurationInput | undefined,
  fallbackMs: number,
  what = "Dedupe window",
): number {
  if (input === undefined) return fallbackMs;
  const ms = typeof input === "number" ? input : parseDuration(input);
  if (ms === undefined || !Number.isInteger(ms) || ms < 1 || ms > MAX_DURATION_MS) {
    const message = `${what} ${JSON.stringify(input)} is invalid: use 1 ms to 365 days, e.g. 60000 or "30m"`;
    throw new FlowlineValidationError(message, [
      { code: "config.invalid", severity: "error", message },
    ]);
  }
  return ms;
}
