import { describe, expect, it } from "vitest";
import { formatDuration } from "./labels";

describe("formatDuration", () => {
  it("scales from milliseconds to days", () => {
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(1200)).toBe("1.2s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(180 * 60_000 + 1000)).toBe("3h");
    expect(formatDuration(95 * 60_000)).toBe("1h 35m");
    expect(formatDuration(26 * 3_600_000)).toBe("1d 2h");
  });
});
