import { MAX_DURATION_MS } from "@flowlinejs/nodes-builtin";
import { describe, expect, it } from "vitest";
import { parseWindow } from "./duration";
import { FlowlineValidationError } from "./errors";

describe("parseWindow", () => {
  it("returns the fallback when no window is given", () => {
    expect(parseWindow(undefined, 1234)).toBe(1234);
  });

  it("accepts milliseconds and duration text", () => {
    expect(parseWindow(1, 0)).toBe(1);
    expect(parseWindow(60_000, 0)).toBe(60_000);
    expect(parseWindow("30s", 0)).toBe(30_000);
    expect(parseWindow("5m", 0)).toBe(300_000);
    expect(parseWindow("2h", 0)).toBe(7_200_000);
    expect(parseWindow("7d", 0)).toBe(7 * 86_400_000);
    expect(parseWindow(MAX_DURATION_MS, 0)).toBe(MAX_DURATION_MS);
    expect(parseWindow("365d", 0)).toBe(MAX_DURATION_MS);
  });

  it.each([
    0,
    -1,
    0.5,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    MAX_DURATION_MS + 1,
    "0s",
    "-1s",
    "nope",
    "",
    "1.5h",
    "366d",
  ])("rejects %j with a FlowlineValidationError", (input) => {
    expect(() => parseWindow(input, 1000)).toThrow(FlowlineValidationError);
  });

  it("names the problem in the message and issues", () => {
    let caught: unknown;
    try {
      parseWindow("nope", 1000);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FlowlineValidationError);
    const err = caught as FlowlineValidationError;
    expect(err.message).toMatch(/dedupe window "nope"/i);
    expect(err.issues).toEqual([
      { code: "config.invalid", severity: "error", message: err.message },
    ]);
  });
});
