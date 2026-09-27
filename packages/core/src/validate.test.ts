import { describe, expect, test } from "vitest";
import { docWith, fixtureDoc, manifest, step } from "../test/fixtures";
import { removeStep } from "./tree";
import type { Step, WorkflowDoc } from "./types";
import { hasErrors, type Issue, validateWorkflow } from "./validate";

const issue = (partial: Partial<Issue>) => expect.objectContaining(partial);
const codes = (issues: Issue[]) => issues.map((i) => i.code);

/** fixtureDoc() with the email step's config merged with `config`. */
function withEmail(config: Step["config"]): WorkflowDoc {
  const doc = fixtureDoc();
  doc.steps[1]!.config = { ...doc.steps[1]!.config, ...config };
  return doc;
}

describe("validateWorkflow", () => {
  test("valid fixture doc has no issues", () => {
    expect(validateWorkflow(fixtureDoc(), manifest)).toEqual([]);
  });

  test("deleting a referenced step yields ref.unresolved on the downstream field", () => {
    let doc = fixtureDoc(); // load → email(to: {$ref:"steps.load.email"})
    doc = removeStep(doc, "load");
    const issues = validateWorkflow(doc, manifest);
    expect(issues).toContainEqual(
      issue({ code: "ref.unresolved", stepId: "email", field: "to", severity: "error" }),
    );
    expect(issues.find((i) => i.field === "to")?.message).toBe(
      '"To" references step "load" which no longer exists',
    );
    // refs inside templates too
    expect(issues).toContainEqual(
      issue({ code: "ref.unresolved", stepId: "email", field: "subject" }),
    );
  });

  test("a missing field on the referenced output is ref.unresolved naming the path", () => {
    const issues = validateWorkflow(
      withEmail({ to: { $ref: "steps.load.address.stret" } }),
      manifest,
    );
    expect(issues).toEqual([
      issue({ code: "ref.unresolved", stepId: "email", field: "to", severity: "error" }),
    ]);
    expect(issues[0]!.message).toContain("address.stret");
    expect(issues[0]!.message).toContain('"To"');
  });

  test("refs into untyped ({}) outputs and payloads resolve at any depth", () => {
    const doc = docWith(
      [
        step("u", "test.untyped"),
        step("email", "crm.sendEmail", {
          to: { $ref: "steps.u.a.b[0].c" },
          subject: { $ref: "trigger.anything.deep" },
          body: "x",
        }),
      ],
      { type: "test.any", config: {} },
    );
    expect(validateWorkflow(doc, manifest)).toEqual([]);
  });

  test("steps inside a branch are out of scope after the rejoin", () => {
    const doc = docWith([
      step("load", "crm.loadContact", { contactId: "c1" }),
      step(
        "cond",
        "test.ifElse",
        { value: true },
        {
          branches: {
            yes: [step("inner", "crm.loadContact", { contactId: { $ref: "steps.load.id" } })],
            no: [],
          },
        },
      ),
      step("email", "crm.sendEmail", {
        to: { $ref: "steps.inner.email" },
        subject: { $ref: "steps.cond.matched" },
        body: "x",
      }),
    ]);
    const issues = validateWorkflow(doc, manifest);
    expect(issues).toEqual([
      issue({ code: "ref.outOfScope", stepId: "email", field: "to", severity: "error" }),
    ]);
    expect(issues[0]!.message).toContain('"inner"');
  });

  test("referencing a later step or itself is ref.outOfScope", () => {
    const doc = docWith([
      step("email", "crm.sendEmail", {
        to: { $ref: "steps.load.email" },
        subject: { $ref: "steps.email.messageId" },
        body: "x",
      }),
      step("load", "crm.loadContact", { contactId: "c1" }),
    ]);
    const issues = validateWorkflow(doc, manifest);
    expect(issues).toEqual([
      issue({ code: "ref.outOfScope", field: "to", message: expect.stringContaining("after") }),
      issue({ code: "ref.outOfScope", field: "subject", message: expect.stringContaining("own") }),
    ]);
  });

  test("loop.item is typed from the items array element", () => {
    const doc = docWith([
      step("load", "crm.loadContact", { contactId: "c1" }),
      step(
        "each",
        "test.each",
        { items: { $ref: "steps.load.orders" } },
        {
          branches: {
            body: [
              step("email", "crm.sendEmail", {
                to: { $ref: "loop.item.id" },
                subject: { $tpl: "Order {{ loop.index }}: {{ loop.item.total }}" },
                body: { $ref: "loop.item.nope" },
              }),
            ],
          },
        },
      ),
    ]);
    const issues = validateWorkflow(doc, manifest);
    expect(issues).toEqual([issue({ code: "ref.unresolved", stepId: "email", field: "body" })]);
  });

  test("loop refs outside a loop, and the loop's own output inside its body, are out of scope", () => {
    const doc = docWith([
      step("load", "crm.loadContact", { contactId: "c1" }),
      step(
        "each",
        "test.each",
        { items: { $ref: "steps.load.orders" } },
        {
          branches: {
            body: [
              step("inner", "crm.sendEmail", {
                to: { $ref: "steps.each.count" },
                subject: "s",
                body: "b",
              }),
            ],
          },
        },
      ),
      step("email", "crm.sendEmail", { to: { $ref: "loop.item.id" }, subject: "s", body: "b" }),
    ]);
    expect(validateWorkflow(doc, manifest)).toEqual([
      issue({ code: "ref.outOfScope", stepId: "inner", field: "to" }),
      issue({ code: "ref.outOfScope", stepId: "email", field: "to" }),
    ]);
  });

  test("switch branches come from config.cases plus default", () => {
    const sw = (branches: Record<string, Step[]>) =>
      docWith([
        step(
          "sw",
          "test.switch",
          {
            value: "a",
            cases: [{ id: "vip", label: "VIP", value: "v" }],
          },
          { branches },
        ),
      ]);
    expect(validateWorkflow(sw({ vip: [], default: [] }), manifest)).toEqual([]);
    const issues = validateWorkflow(sw({ vip: [], gold: [] }), manifest);
    expect(issues).toEqual([
      issue({ code: "branch.unknown", stepId: "sw", severity: "error" }),
      issue({ code: "branch.missing", stepId: "sw", severity: "warning" }),
    ]);
    expect(issues[0]!.message).toContain('"gold"');
    expect(issues[1]!.message).toContain("Default");
  });

  test("static branches and branch-less nodes", () => {
    const doc = docWith([
      step("cond", "test.ifElse", { value: true }, { branches: { yes: [], no: [], maybe: [] } }),
      step("load", "crm.loadContact", { contactId: "x" }, { branches: { yes: [] } }),
    ]);
    expect(codes(validateWorkflow(doc, manifest))).toEqual(["branch.unknown", "branch.unknown"]);
  });

  test("fields output node exposes declared fields to downstream", () => {
    const doc = docWith([
      step("set", "test.fields", {
        fields: [
          { name: "total", type: "number" },
          { name: "label", type: "string" },
          { name: "meta", type: "object" },
        ],
      }),
      step("email", "crm.sendEmail", {
        to: { $ref: "steps.set.label" },
        subject: { $ref: "steps.set.total" },
        body: { $ref: "steps.set.undeclared" }, // fields schemas are open: lenient
        priority: { $ref: "steps.set.label" },
        cc: { $ref: "steps.set.meta" },
      }),
    ]);
    expect(validateWorkflow(doc, manifest)).toEqual([
      issue({ code: "ref.typeMismatch", field: "priority", severity: "warning" }),
      issue({ code: "ref.typeMismatch", field: "cc", severity: "warning" }),
    ]);
  });

  test("object → string ref is a typeMismatch warning with a readable message", () => {
    const issues = validateWorkflow(withEmail({ to: { $ref: "steps.load.address" } }), manifest);
    expect(issues).toEqual([issue({ code: "ref.typeMismatch", field: "to", severity: "warning" })]);
    expect(issues[0]!.message).toBe('"To" expects string but steps.load.address is { city, zip }');
  });

  test("number literal in a string field is config.invalid", () => {
    const issues = validateWorkflow(withEmail({ body: 42 }), manifest);
    expect(issues).toEqual([
      issue({ code: "config.invalid", stepId: "email", field: "body", severity: "error" }),
    ]);
    expect(issues[0]!.message).toContain('"Body"');
  });

  test("literal checks: enum, length, range, integer, date-time, arrays, nested objects", () => {
    const issues = validateWorkflow(
      withEmail({
        subject: "x".repeat(51),
        mode: "pdf",
        priority: 9,
        sendAt: "tomorrow",
        cc: ["a@b.c", 3],
        headers: {},
      }),
      manifest,
    );
    expect(issues.map((i) => [i.code, i.field])).toEqual([
      ["config.invalid", "subject"],
      ["config.invalid", "priority"],
      ["config.invalid", "sendAt"],
      ["config.invalid", "mode"],
      ["config.invalid", "cc[1]"],
      ["config.required", "headers.replyTo"],
    ]);
    expect(validateWorkflow(withEmail({ priority: 2.5 }), manifest)).toEqual([
      issue({ code: "config.invalid", field: "priority" }),
    ]);
    expect(
      validateWorkflow(
        withEmail({ sendAt: "2026-09-27T10:00:00Z", mode: "text", priority: 3, cc: [] }),
        manifest,
      ),
    ).toEqual([]);
  });

  test("empty required field → config.required", () => {
    const doc = fixtureDoc();
    delete doc.steps[1]!.config.to;
    doc.steps[1]!.config.body = "";
    const issues = validateWorkflow(doc, manifest);
    expect(issues).toEqual([
      issue({ code: "config.required", stepId: "email", field: "to", severity: "error" }),
      issue({ code: "config.required", stepId: "email", field: "body", severity: "error" }),
    ]);
    expect(issues[0]!.message).toBe('"To" is required');
  });

  test("literalOnly fields reject refs; refOnly fields reject literals", () => {
    const doc = withEmail({ template: { $ref: "steps.load.name" } });
    expect(validateWorkflow(doc, manifest)).toEqual([
      issue({ code: "config.invalid", field: "template" }),
    ]);
    const loop = docWith([
      step("each", "test.each", { items: [1, 2] }, { branches: { body: [] } }),
    ]);
    expect(validateWorkflow(loop, manifest)).toEqual([
      issue({ code: "config.invalid", field: "items" }),
    ]);
  });

  test("template in a number field is a typeMismatch warning", () => {
    expect(
      validateWorkflow(withEmail({ priority: { $tpl: "{{ steps.load.age }}" } }), manifest),
    ).toEqual([issue({ code: "ref.typeMismatch", field: "priority", severity: "warning" })]);
  });

  test("ref.syntax for malformed paths (in refs and templates)", () => {
    const issues = validateWorkflow(
      withEmail({ to: { $ref: "steps..email" }, subject: { $tpl: "Hi {{ nope.x }}" } }),
      manifest,
    );
    expect(issues).toEqual([
      issue({ code: "ref.syntax", field: "to", severity: "error" }),
      issue({ code: "ref.syntax", field: "subject", severity: "error" }),
    ]);
  });

  test("unknown trigger and node types", () => {
    const doc = docWith([step("x", "nope.node", { a: 1 }, { branches: { any: [] } })], {
      type: "nope.trigger",
      config: {},
    });
    expect(validateWorkflow(doc, manifest)).toEqual([
      issue({ code: "trigger.unknown", severity: "error" }),
      issue({ code: "node.unknown", stepId: "x", severity: "error" }),
    ]);
  });

  test("duplicate and invalid step IDs", () => {
    const doc = docWith([
      step("a", "test.untyped"),
      step("a", "test.untyped"),
      step("1bad", "test.untyped"),
    ]);
    expect(validateWorkflow(doc, manifest)).toEqual([
      issue({ code: "step.duplicateId", stepId: "a", severity: "error" }),
      issue({ code: "step.invalidId", stepId: "1bad", severity: "error" }),
    ]);
  });

  test("empty doc is a warning", () => {
    const issues = validateWorkflow(docWith([]), manifest);
    expect(issues).toEqual([issue({ code: "doc.empty", severity: "warning" })]);
    expect(hasErrors(issues)).toBe(false);
  });

  test("trigger config: literals validated, refs rejected", () => {
    const bad = docWith([step("u", "test.untyped")], {
      type: "crm.contactCreated",
      config: { source: "fax" },
    });
    expect(validateWorkflow(bad, manifest)).toEqual([
      issue({ code: "config.invalid", field: "trigger.source" }),
    ]);
    const ref = docWith([step("u", "test.untyped")], {
      type: "crm.contactCreated",
      config: { source: { $ref: "trigger.source" } },
    });
    const issues = validateWorkflow(ref, manifest);
    expect(issues).toEqual([
      issue({ code: "config.invalid", field: "trigger.source", severity: "error" }),
    ]);
    expect(issues[0]!.stepId).toBeUndefined();
  });

  test("subflows: unknown, recursive, typed output and input mapping", () => {
    const ctx = {
      subflows: {
        child: {
          name: "Child",
          input: {
            type: "object",
            properties: { email: { type: "string" }, count: { type: "number" } },
            required: ["email"],
          },
          output: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            additionalProperties: false,
          },
        },
      },
    };
    const doc = (workflowId: string, input: Step["config"][string] = { email: "a@b.c" }) =>
      docWith([
        step("sub", "test.sub", { workflowId, input }),
        step("email", "crm.sendEmail", { to: { $ref: "steps.sub.ok" }, subject: "s", body: "b" }),
      ]);
    expect(validateWorkflow(doc("child"), manifest, ctx)).toEqual([]);
    expect(validateWorkflow(doc("ghost"), manifest, ctx)).toEqual([
      issue({ code: "subflow.unknown", stepId: "sub", field: "workflowId", severity: "error" }),
    ]);
    expect(validateWorkflow(doc("wf"), manifest, ctx)).toContainEqual(
      issue({ code: "subflow.recursive", stepId: "sub", severity: "error" }),
    );
    expect(validateWorkflow(doc("child", { count: "many" }), manifest, ctx)).toEqual([
      issue({ code: "config.required", stepId: "sub", field: "input.email" }),
      issue({ code: "config.invalid", stepId: "sub", field: "input.count" }),
    ]);
    const wrongField = doc("child");
    wrongField.steps[1]!.config.to = { $ref: "steps.sub.nope" };
    expect(validateWorkflow(wrongField, manifest, ctx)).toEqual([
      issue({ code: "ref.unresolved", stepId: "email", field: "to" }),
    ]);
    // Without a context, subflow IDs can't be checked (only recursion can).
    expect(validateWorkflow(doc("ghost"), manifest)).toEqual([]);
  });

  test("doc.output mapping is validated against the end-of-doc scope", () => {
    const doc = docWith([
      step("load", "crm.loadContact", { contactId: "c1" }),
      step(
        "cond",
        "test.ifElse",
        { value: true },
        {
          branches: { yes: [step("inner", "test.untyped")], no: [] },
        },
      ),
    ]);
    doc.output = {
      email: { $ref: "steps.load.email" },
      inner: { $ref: "steps.inner.x" },
      gone: { $ref: "steps.ghost" },
      bad: { $ref: "steps.load.nope" },
    };
    const issues = validateWorkflow(doc, manifest);
    expect(issues).toEqual([
      issue({ code: "ref.outOfScope", field: "output.inner" }),
      issue({ code: "ref.unresolved", field: "output.gone" }),
      issue({ code: "ref.unresolved", field: "output.bad" }),
    ]);
    expect(issues.every((i) => i.stepId === undefined)).toBe(true);
  });

  test("disabled steps are validated with warnings; refs to them warn", () => {
    const doc = fixtureDoc();
    doc.steps[0]!.disabled = true;
    doc.steps[0]!.config = {};
    const issues = validateWorkflow(doc, manifest);
    expect(issues).toEqual([
      issue({ code: "config.required", stepId: "load", severity: "warning" }),
      issue({ code: "ref.typeMismatch", stepId: "email", field: "to", severity: "warning" }),
      issue({ code: "ref.typeMismatch", stepId: "email", field: "subject", severity: "warning" }),
    ]);
    expect(issues[1]!.message).toContain("disabled");
    expect(hasErrors(issues)).toBe(false);
  });

  test("steps inside a disabled block only produce warnings", () => {
    const doc = docWith([
      step(
        "cond",
        "test.ifElse",
        { value: true },
        {
          disabled: true,
          branches: {
            yes: [step("inner", "crm.sendEmail", { subject: "s", body: "b" })],
            no: [],
          },
        },
      ),
    ]);
    expect(validateWorkflow(doc, manifest)).toEqual([
      issue({ code: "config.required", stepId: "inner", field: "to", severity: "warning" }),
    ]);
  });

  test("validates a 200-step doc in under 20ms", () => {
    const steps: Step[] = [
      step("load", "crm.loadContact", { contactId: { $ref: "trigger.contactId" } }),
    ];
    for (let i = 0; i < 99; i++) {
      steps.push(
        step(`email_${i}`, "crm.sendEmail", {
          to: { $ref: "steps.load.email" },
          subject: { $tpl: `Hi {{ steps.load.name }} #${i}` },
          body: "b",
        }),
      );
      steps.push(
        step(
          `cond_${i}`,
          "test.ifElse",
          { value: true },
          {
            branches: { yes: [], no: [] },
          },
        ),
      );
    }
    const doc = docWith(steps);
    expect(validateWorkflow(doc, manifest)).toEqual([]);
    const runs = 5;
    const start = performance.now();
    for (let i = 0; i < runs; i++) validateWorkflow(doc, manifest);
    expect((performance.now() - start) / runs).toBeLessThan(20);
  });
});

test("hasErrors", () => {
  expect(hasErrors([])).toBe(false);
  expect(hasErrors([{ code: "doc.empty", severity: "warning", message: "" }])).toBe(false);
  expect(hasErrors([{ code: "node.unknown", severity: "error", message: "" }])).toBe(true);
});
