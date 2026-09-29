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

describe("annotation labels", () => {
  it("names the six colours", () => {
    expect(defaultLabels.colorNames).toEqual({
      yellow: "Yellow",
      blue: "Blue",
      green: "Green",
      pink: "Pink",
      purple: "Purple",
      gray: "Gray",
    });
  });

  it("names a section's region and header chip, with the note when there is one", () => {
    expect(defaultLabels.sectionRegion("Onboarding")).toBe("Section: Onboarding");
    expect(defaultLabels.sectionHeader("Onboarding")).toBe("Onboarding");
    expect(defaultLabels.sectionHeader("Onboarding", "Runs daily")).toBe(
      "Onboarding. Note: Runs daily",
    );
  });

  it("an untitled section still has a name", () => {
    expect(defaultLabels.sectionRegion("")).toBe("Section: Untitled section");
    expect(defaultLabels.sectionHeader("  ")).toBe("Untitled section");
  });

  it("prefixes a note, and a step's name carries the first 120 characters of its note", () => {
    expect(defaultLabels.noteLabel("Check with legal")).toBe("Note: Check with legal");
    expect(defaultLabels.stepWithNote("Send email", "Short")).toBe("Send email. Note: Short");
    const long = "a".repeat(300);
    expect(defaultLabels.stepWithNote("Send email", long)).toBe(
      `Send email. Note: ${"a".repeat(120)}`,
    );
  });
});

describe("range labels", () => {
  it("counts the selected steps and names the defaults", () => {
    expect(defaultLabels.rangeSelected(3)).toBe("3 steps selected");
    expect(defaultLabels.rangeSelected(1)).toBe("1 step selected");
    expect(defaultLabels.defaultSectionTitle).toBe("Section");
    expect(defaultLabels.rangeOtherList).toBe(
      "A range must stay in one branch. Shift-click a step in the same list.",
    );
    expect(defaultLabels.stepsDeleted(2)).toBe("Deleted 2 steps");
    expect(defaultLabels.stepsDeleted(1)).toBe("Deleted 1 step");
    expect(defaultLabels.groupIntoSection).toBe("Group into section");
    expect(defaultLabels.stepInRange("Send email")).toBe("Send email, in selection");
    expect(defaultLabels.rangeCleared).toBe("Selection cleared");
    expect(defaultLabels.sectionOverlap("Intro")).toContain("“Intro”");
  });

  it("can be overridden", () => {
    expect(resolveLabels({ groupIntoSection: "Grouper" }).groupIntoSection).toBe("Grouper");
  });
});

describe("annotation menu labels", () => {
  it("names the menu items, toasts and fields", () => {
    expect(defaultLabels.ungroup).toBe("Ungroup");
    expect(defaultLabels.renameSection).toBe("Rename");
    expect(defaultLabels.sectionNote).toBe("Note");
    expect(defaultLabels.color).toBe("Color");
    expect(defaultLabels.noColor).toBe("No color");
    expect(defaultLabels.addNote).toBe("Add note");
    expect(defaultLabels.editNote).toBe("Edit note");
    expect(defaultLabels.removeNote).toBe("Remove note");
    expect(defaultLabels.noteDeleted).toBe("Note removed");
    expect(defaultLabels.fixIssue).toBe("Fix");
    expect(defaultLabels.shortenNote).toBe("Shorten");
    expect(defaultLabels.sectionTitleInput).toBe("Section title");
    expect(defaultLabels.sectionDeleted("Intro")).toBe("Removed section “Intro”");
    expect(defaultLabels.sectionDeleted(" ")).toBe("Removed section “Untitled section”");
    expect(defaultLabels.sectionMenu("Intro")).toBe("Section actions: Intro");
  });

  it("can be overridden", () => {
    expect(resolveLabels({ ungroup: "Dégrouper" }).ungroup).toBe("Dégrouper");
  });
});
