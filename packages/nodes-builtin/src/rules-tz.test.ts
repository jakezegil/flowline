// Runs the date rules under a non-UTC server time zone: offset-less dates and date-times must still
// be read as UTC. Node applies a changed `process.env.TZ` to later Date calls; the zone is restored
// after this file.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateRules, type Rule } from "./rules";

const one = (rule: Rule) => evaluateRules({ combinator: "and", rules: [rule] });

let previousTz: string | undefined;
beforeAll(() => {
  previousTz = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
});
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

describe("date rules in a non-UTC time zone", () => {
  it("really runs outside UTC", () => {
    // Pacific Standard Time is UTC-8 in January.
    expect(new Date(Date.UTC(2026, 0, 1)).getTimezoneOffset()).toBe(480);
    // What the old Date.parse-based reading would have done: local time, not UTC.
    expect(Date.parse("2026-01-01T09:00")).not.toBe(Date.parse("2026-01-01T09:00Z"));
  });

  it.each([
    ["2026-01-01T09:00", "2026-01-01T09:00:00Z"],
    ["2026-01-01T09:00:00", "2026-01-01T09:00:00.000Z"],
    ["2026-01-01 09:00:00.250", "2026-01-01T09:00:00.25Z"],
    ["2026-01-01", "2026-01-01T00:00:00Z"],
  ])("reads %s as UTC", (local, utc) => {
    expect(one({ left: local, op: "eq", right: utc })).toBe(true);
    expect(one({ left: local, op: "gte", right: utc })).toBe(true);
    expect(one({ left: local, op: "lte", right: utc })).toBe(true);
  });

  it("orders offset-less date-times against date-only ones consistently", () => {
    // 23:30 UTC on Jan 1 is before Jan 2 (midnight UTC), whatever the server's zone.
    expect(one({ left: "2026-01-01T23:30", op: "lt", right: "2026-01-02" })).toBe(true);
    expect(one({ left: "2026-01-02T00:30", op: "gt", right: "2026-01-02" })).toBe(true);
  });

  it("still honours explicit offsets", () => {
    expect(one({ left: "2026-01-01T01:00:00-08:00", op: "eq", right: "2026-01-01T09:00" })).toBe(
      true,
    );
    expect(one({ left: "2026-01-01T10:00+01:00", op: "eq", right: "2026-01-01T09:00" })).toBe(true);
    expect(one({ left: "2026-01-01T10:00+0100", op: "eq", right: "2026-01-01T09:00" })).toBe(true);
  });
});
