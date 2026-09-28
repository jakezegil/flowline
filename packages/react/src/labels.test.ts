import { describe, expect, it } from "vitest";
import { defaultLabels, formatDuration } from "./labels";

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

describe("relativeTime", () => {
  it("says a moment ahead is ahead, not just now", () => {
    expect(defaultLabels.relativeTime(30_000)).toBe("in a few seconds");
    expect(defaultLabels.relativeTime(0)).toBe("just now");
    expect(defaultLabels.relativeTime(-30_000)).toBe("just now");
    expect(defaultLabels.relativeTime(5 * 60_000)).toMatch(/^in 5 min/);
  });
});

describe("triggerEvents", () => {
  it("lists every event when there are three or fewer", () => {
    expect(defaultLabels.triggerEvents(["ai_call.ended", "voip_call.ended"])).toBe(
      "When any of: ai_call.ended, voip_call.ended",
    );
    expect(defaultLabels.triggerEvents(["a", "b", "c"])).toBe("When any of: a, b, c");
  });

  it("truncates past three with a +N more suffix", () => {
    expect(defaultLabels.triggerEvents(["a", "b", "c", "d"])).toBe("When any of: a, b, c, +1 more");
    expect(defaultLabels.triggerEvents(["a", "b", "c", "d", "e"])).toBe(
      "When any of: a, b, c, +2 more",
    );
  });
});

describe("triggerEventsHint", () => {
  it("lists every event and says payloads are normalized", () => {
    const hint = defaultLabels.triggerEventsHint(["ai_call.ended", "voip_call.ended"]);
    expect(hint).toContain("ai_call.ended");
    expect(hint).toContain("voip_call.ended");
    expect(hint).toMatch(/normalized/i);
  });
});
