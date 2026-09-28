import type { JSONSchema, Step } from "@flowkit/core";
import { describe, expect, test } from "vitest";
import { renderSummary } from "./summary";

const schema: JSONSchema = {
  type: "object",
  properties: {
    to: { type: "string", "x-flowkit": { label: "Recipient" } },
    subject: { type: "string", "x-flowkit": { label: "Subject" } },
    duration: { type: "string", default: "1h" },
    contactId: { type: "string" },
    url: { type: "string", title: "URL" },
    retry: { type: "object", properties: { count: { type: "number", default: 3 } } },
  },
};

const step = (config: Step["config"]): Step => ({ id: "s", type: "t", config });
const noNames = () => undefined;

describe("renderSummary", () => {
  test("an unset value with a schema default shows the default", () => {
    const r = renderSummary("Wait {{duration}}", step({}), noNames, schema);
    expect(r.parts).toEqual([
      { kind: "text", text: "Wait " },
      { kind: "default", text: "1h" },
    ]);
    expect(r.blank).toBe(false);
  });

  test("defaults are found at nested paths", () => {
    const r = renderSummary("{{retry.count}} tries", step({}), noNames, schema);
    expect(r.parts[0]).toEqual({ kind: "default", text: "3" });
  });

  test('an unset value without a default reads "No <label>" from x-flowkit.label', () => {
    const r = renderSummary("{{subject}}", step({ subject: "" }), noNames, schema);
    expect(r.parts).toEqual([{ kind: "empty", label: "No subject" }]);
  });

  test("falls back to the schema title, keeping acronyms, then to the humanized key", () => {
    expect(renderSummary("{{url}}", step({}), noNames, schema).parts).toEqual([
      { kind: "empty", label: "No URL" },
    ]);
    expect(renderSummary("{{contactId}}", step({}), noNames, schema).parts).toEqual([
      { kind: "empty", label: "No contact id" },
    ]);
    expect(renderSummary("{{due_date}}", step({}), noNames).parts).toEqual([
      { kind: "empty", label: "No due date" },
    ]);
  });

  test("blank only when every value in the template is unset without a default", () => {
    expect(renderSummary("{{to}}: {{subject}}", step({}), noNames, schema).blank).toBe(true);
    expect(renderSummary("{{to}}: {{subject}}", step({ to: "a" }), noNames, schema).blank).toBe(
      false,
    );
    expect(renderSummary("Static text", step({}), noNames, schema).blank).toBe(false);
  });

  test("set values still render as text and ref pills", () => {
    const r = renderSummary(
      "{{to}} {{subject}}",
      step({ to: { $ref: "trigger.email" }, subject: "Hi" }),
      noNames,
      schema,
    );
    expect(r.parts).toEqual([
      { kind: "ref", ref: "trigger.email", label: "Trigger › email" },
      { kind: "text", text: " Hi" },
    ]);
  });

  test("M10: optional sections show only while their field is set and shown; choices by label", () => {
    const assign: JSONSchema = {
      type: "object",
      properties: {
        strategy: { type: "string", enum: ["roundRobin", "team"], default: "roundRobin" },
        team: {
          type: "string",
          enum: ["smb", "enterprise"],
          "x-flowkit": {
            enumLabels: { smb: "SMB", enterprise: "Enterprise" },
            showIf: { field: "strategy", equals: "team" },
          },
        },
      },
    };
    const summary = "{{strategy}}{{#team}} · {{team}}{{/team}}";
    const text = (config: Step["config"]) =>
      renderSummary(summary, step(config), noNames, assign)
        .parts.map((p) => ("text" in p ? p.text : p.kind === "ref" ? p.label : p.label))
        .join("");
    expect(text({})).toBe("Round robin");
    expect(text({ strategy: "team", team: "smb" })).toBe("Team · SMB");
    expect(text({ strategy: "team" })).toBe("Team");
    // A team left over from before switching back to round robin is hidden, so not shown.
    expect(text({ strategy: "roundRobin", team: "enterprise" })).toBe("Round robin");
    expect(text({ strategy: "team", team: { $ref: "trigger.team" } })).toBe(
      "Team · Trigger › team",
    );
  });
});
