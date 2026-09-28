import type { NodeManifest } from "@flowkit/core";
import { describe, expect, test } from "vitest";
import { rankSteps, stepMatchScore } from "./step-picker";

const node = (
  type: string,
  name: string,
  category: string,
  description: string,
  keywords?: string[],
): NodeManifest => ({
  type,
  plugin: type.split(".")[0] as string,
  name,
  category,
  description,
  ...(keywords ? { keywords } : {}),
  input: {},
  output: { kind: "schema", schema: {} },
  branches: { kind: "none" },
});

// The built-in and mini-crm steps, in picker order, with their real descriptions.
const nodes = [
  node(
    "core.condition",
    "If / else",
    "Logic",
    "Take the If path when the conditions match, and the Else path when they don't.",
    ["if", "else", "condition", "branch", "filter"],
  ),
  node(
    "core.switch",
    "Switch",
    "Logic",
    "Take the path of the first case whose value matches, or Default when none does. Each case sends an email, updates a contact…",
    ["case", "route", "branch", "match"],
  ),
  node(
    "core.forEach",
    "For each",
    "Logic",
    "Run the steps inside once per item of a list, e.g. for every approval or contact.",
    ["loop", "iterate", "each", "list"],
  ),
  node("core.stop", "Stop", "Logic", "End the run here as a success. No later steps run.", [
    "end",
    "exit",
  ]),
  node("core.delay", "Delay", "Timing", "Pause the run for a while, then continue.", [
    "wait",
    "sleep",
    "pause",
  ]),
  node(
    "core.waitForCallback",
    "Wait for callback",
    "Timing",
    "Pause until another system calls back.",
    ["webhook", "callback"],
  ),
  node("core.httpRequest", "HTTP request", "Integrations", "Call an external HTTP API.", [
    "api",
    "fetch",
  ]),
  node("crm.findContact", "Find contact by email", "Contacts", "Look up a contact by email."),
  node("crm.getContact", "Get contact", "Contacts", "Load a contact and its owner."),
  node("crm.createContact", "Create contact", "Contacts", "Add a new contact to the CRM."),
  node("crm.assignOwner", "Assign owner", "Contacts", "Pick an owner for the contact."),
  node("crm.sendEmail", "Send email", "Email", "Send an email from the CRM.", ["mail", "notify"]),
  node(
    "crm.requestApproval",
    "Request approval",
    "Approvals",
    "Ask a user to approve, and wait for their decision.",
  ),
];
const top = (q: string) => rankSteps([{ nodes }], q)[0]?.name;
const names = (q: string) => rankSteps([{ nodes }], q).map((n) => n.name);

describe("step picker search (H3)", () => {
  test("the step named by the query ranks first", () => {
    expect(top("Send email")).toBe("Send email");
    expect(top("send email")).toBe("Send email");
    expect(top("email")).toBe("Send email");
    expect(top("approval")).toBe("Request approval");
    expect(top("if")).toBe("If / else");
    expect(top("for")).toBe("For each");
    expect(top("wait")).toBe("Wait for callback");
  });

  test("descriptions aren't searched, so unrelated steps drop out", () => {
    expect(names("approval")).toEqual(["Request approval"]);
    expect(names("contact")).toEqual([
      "Find contact by email",
      "Get contact",
      "Create contact",
      "Assign owner",
    ]);
    expect(names("email")).toEqual(["Send email", "Find contact by email"]);
    expect(names("zzz")).toEqual([]);
  });

  test("keywords find synonyms, below name matches", () => {
    expect(names("sleep")).toEqual(["Delay"]);
    expect(names("loop")).toEqual(["For each"]);
    expect(stepMatchScore(nodes[4] as NodeManifest, "wait")).toBeLessThan(
      stepMatchScore(nodes[5] as NodeManifest, "wait"),
    );
  });

  test("an empty query matches everything in order", () => {
    expect(names("  ")).toEqual(nodes.map((n) => n.name));
  });
});
