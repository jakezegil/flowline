import { describe, expect, it } from "vitest";
import { walkSteps } from "../tree";
import type { WorkflowDoc } from "../types";
import { crmLikeManifest, specExampleDoc } from "./fixtures";
import { matchSteps } from "./selectors";

const m = crmLikeManifest();

/** The spec doc plus a named step inside the section's `recheck` subtree and one after it. */
function doc(): WorkflowDoc {
  const d = specExampleDoc();
  d.steps.push({
    id: "lastMail",
    type: "crm.sendEmail",
    name: "Final MAIL to owner",
    config: { to: "a@b.c", subject: "Bye" },
  });
  return d;
}

function allIds(d: WorkflowDoc): string[] {
  const ids: string[] = [];
  walkSteps(d, (s) => ids.push(s.id));
  return ids;
}

describe("matchSteps", () => {
  it("{} matches every step in pre-order", () => {
    const d = doc();
    expect(matchSteps(d, m, {})).toEqual(allIds(d));
    expect(matchSteps(d, m, {})).toEqual([
      "getDeal",
      "recheck",
      "notifyOwner",
      "stopMoved",
      "delay_1m",
      "lastMail",
    ]);
  });

  it("type", () => {
    expect(matchSteps(doc(), m, { type: "crm.sendEmail" })).toEqual(["notifyOwner", "lastMail"]);
    expect(matchSteps(doc(), m, { type: "nope" })).toEqual([]);
  });

  it("section: members and their subtrees", () => {
    expect(matchSteps(doc(), m, { section: "check" })).toEqual([
      "getDeal",
      "recheck",
      "notifyOwner",
      "stopMoved",
    ]);
  });

  it("within: descendants of a step, optionally of one branch", () => {
    expect(matchSteps(doc(), m, { within: { stepId: "recheck" } })).toEqual([
      "notifyOwner",
      "stopMoved",
    ]);
    expect(matchSteps(doc(), m, { within: { stepId: "recheck", branch: "else" } })).toEqual([
      "stopMoved",
    ]);
    expect(matchSteps(doc(), m, { within: { stepId: "getDeal" } })).toEqual([]);
  });

  it("nameContains: case-insensitive on name, else node label, else ID", () => {
    expect(matchSteps(doc(), m, { nameContains: "mail" })).toEqual(["notifyOwner", "lastMail"]);
    // `lastMail` has a name, so its node label "Send email" isn't used, but the name matches.
    expect(matchSteps(doc(), m, { nameContains: "send" })).toEqual(["notifyOwner"]);
    expect(matchSteps(doc(), m, { nameContains: "OWNER" })).toEqual(["lastMail"]);
    const unknown: WorkflowDoc = {
      ...doc(),
      steps: [{ id: "mystery_1", type: "x.unknown", config: {} }],
      sections: [],
    };
    expect(matchSteps(unknown, m, { nameContains: "mystery" })).toEqual(["mystery_1"]);
  });

  it("configHas: a present config path", () => {
    expect(matchSteps(doc(), m, { configHas: "body" })).toEqual(["notifyOwner"]);
    // A reference counts as present.
    expect(matchSteps(doc(), m, { configHas: "to" })).toEqual(["notifyOwner", "lastMail"]);
    expect(matchSteps(doc(), m, { configHas: "to.nested" })).toEqual([]);
  });

  it("fields are ANDed", () => {
    expect(matchSteps(doc(), m, { type: "crm.sendEmail", section: "check" })).toEqual([
      "notifyOwner",
    ]);
    expect(
      matchSteps(doc(), m, {
        type: "crm.sendEmail",
        within: { stepId: "recheck" },
        configHas: "body",
      }),
    ).toEqual(["notifyOwner"]);
    expect(
      matchSteps(doc(), m, { type: "flow.stop", nameContains: "stop", section: "check" }),
    ).toEqual(["stopMoved"]);
    expect(matchSteps(doc(), m, { type: "flow.stop", configHas: "reason" })).toEqual([]);
  });

  it("a broken section matches nothing and doesn't throw", () => {
    const d: WorkflowDoc = {
      ...doc(),
      sections: [{ id: "b", title: "B", color: "blue", first: "delay_1m", last: "getDeal" }],
    };
    expect(matchSteps(d, m, { section: "b" })).toEqual([]);
  });
});
