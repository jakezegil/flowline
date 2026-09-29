import { describe, expect, it } from "vitest";
import { defaultLabels, formatDuration, formatPollInterval, resolveLabels } from "./labels";

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

describe("formatPollInterval", () => {
  it("describes an interval that isn't a whole minute in seconds, not rounded minutes", () => {
    expect(formatPollInterval(90_000)).toBe("every 90 seconds");
  });

  it("uses the singular minute for exactly 60 seconds", () => {
    expect(formatPollInterval(60_000)).toBe("every minute");
  });

  it("uses the singular hour for exactly one hour", () => {
    expect(formatPollInterval(3_600_000)).toBe("every hour");
  });

  it("prefers hours over an inexact day for 36 hours", () => {
    expect(formatPollInterval(36 * 3_600_000)).toBe("every 36 hours");
  });
});

describe("triggerPoll", () => {
  it("reads naturally for seconds, minutes, hours and days", () => {
    expect(defaultLabels.triggerPoll(300_000)).toBe("Checks every 5 minutes");
    expect(defaultLabels.triggerPoll(10_000)).toBe("Checks every 10 seconds");
    expect(defaultLabels.triggerPoll(3_600_000)).toBe("Checks every hour");
    expect(defaultLabels.triggerPoll(2 * 3_600_000)).toBe("Checks every 2 hours");
    expect(defaultLabels.triggerPoll(86_400_000)).toBe("Checks every day");
    expect(defaultLabels.triggerPoll(2 * 86_400_000)).toBe("Checks every 2 days");
  });

  it("uses the singular for exactly one interval, not '1 minute'", () => {
    expect(defaultLabels.triggerPoll(60_000)).toBe("Checks every minute");
  });
});

describe("originPoll", () => {
  it("names the item that started the run", () => {
    expect(defaultLabels.originPoll("deal_123")).toBe("Polled (item deal_123)");
  });
});

describe("origin", () => {
  it("renders a poll origin through originPoll", () => {
    const origin = { kind: "poll" as const, since: 0, until: 1, itemKey: "deal_123" };
    expect(defaultLabels.origin(origin)).toBe(defaultLabels.originPoll("deal_123"));
  });
});

describe("resolveLabels: Ruling 102", () => {
  const pollOrigin = { kind: "poll" as const, since: 0, until: 1, itemKey: "deal_123" };

  it("an originPoll-only override reaches origin's poll rendering", () => {
    const labels = resolveLabels({ originPoll: (k) => `X ${k}` });
    expect(labels.origin(pollOrigin)).toBe("X deal_123");
  });

  it("an origin override wins outright, for every kind, even with originPoll overridden too", () => {
    const labels = resolveLabels({
      origin: () => "custom",
      originPoll: (k) => `X ${k}`,
    });
    expect(labels.origin(pollOrigin)).toBe("custom");
    expect(labels.origin({ kind: "manual" })).toBe("custom");
  });
});
