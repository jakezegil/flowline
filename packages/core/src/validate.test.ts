import { describe, expect, test } from "vitest";
import { z } from "zod";
import { docWith, fixtureDoc, manifest, step } from "../test/fixtures";
import { defineNode, definePlugin, defineTrigger } from "./define";
import { createRegistry } from "./registry";
import { removeStep } from "./tree";
import type { JSONSchema, Manifest, NodeManifest, Step, WorkflowDoc } from "./types";
import { UI_META_KEY, ui } from "./ui";
import { checkJson, hasErrors, type Issue, validateWorkflow } from "./validate";

const issue = (partial: Partial<Issue>) => expect.objectContaining(partial);
const tupleNode = defineNode({
  type: "x.tuple",
  name: "Tuple",
  input: z.object({ pair: z.tuple([z.string(), z.number()]) }),
  run: () => ({}),
});
const dedupeTrigger = defineTrigger({
  type: "x.dedupe",
  name: "Dedupe",
  kind: "event",
  event: "order",
  config: z.object({ dedupeKey: z.string().optional() }),
  payload: z.object({ orderId: z.string(), meta: z.object({ a: z.string() }) }),
});
/** The fixture manifest plus extra node/trigger definitions under plugin "x". */
function extend(
  nodes: Parameters<typeof definePlugin>[0]["nodes"] = [],
  triggers: Parameters<typeof definePlugin>[0]["triggers"] = [],
): Manifest {
  const extra = createRegistry([definePlugin({ id: "x", name: "X", nodes, triggers })]).manifest();
  return {
    plugins: [...manifest.plugins, ...extra.plugins],
    nodes: [...manifest.nodes, ...extra.nodes],
    triggers: [...manifest.triggers, ...extra.triggers],
  };
}
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

  test("reserved object-property step IDs are invalid", () => {
    const doc = docWith([
      step("__proto__", "test.untyped"),
      step("constructor", "test.untyped"),
      step("prototype", "test.untyped"),
      step("__trigger", "test.untyped"),
    ]);
    expect(validateWorkflow(doc, manifest)).toEqual([
      issue({ code: "step.invalidId", stepId: "__proto__", severity: "error" }),
      issue({ code: "step.invalidId", stepId: "constructor", severity: "error" }),
      issue({ code: "step.invalidId", stepId: "prototype", severity: "error" }),
      issue({ code: "step.invalidId", stepId: "__trigger", severity: "error" }),
    ]);
  });

  test("empty doc is a warning", () => {
    const issues = validateWorkflow(docWith([]), manifest);
    expect(issues).toEqual([issue({ code: "doc.empty", severity: "warning" })]);
    expect(hasErrors(issues)).toBe(false);
  });

  test("trigger config: literals validated; only trigger-rooted refs allowed", () => {
    const bad = docWith([step("u", "test.untyped")], {
      type: "crm.contactCreated",
      config: { source: "fax" },
    });
    expect(validateWorkflow(bad, manifest)).toEqual([
      issue({ code: "config.invalid", field: "trigger.source" }),
    ]);
    const ref = docWith([step("u", "test.untyped")], {
      type: "crm.contactCreated",
      config: { source: { $ref: "steps.u.x" } },
    });
    const issues = validateWorkflow(ref, manifest);
    expect(issues).toEqual([
      issue({ code: "config.invalid", field: "trigger.source", severity: "error" }),
    ]);
    expect(issues[0]!.stepId).toBeUndefined();
  });

  test("trigger config refs rooted at trigger. resolve against the payload", () => {
    const m = extend([], [dedupeTrigger]);
    const doc = (dedupeKey: Step["config"][string]) =>
      docWith([step("u", "test.untyped")], { type: "x.dedupe", config: { dedupeKey } });
    expect(validateWorkflow(doc({ $ref: "trigger.orderId" }), m)).toEqual([]);
    expect(validateWorkflow(doc({ $tpl: "order-{{ trigger.orderId }}" }), m)).toEqual([]);
    expect(validateWorkflow(doc({ $ref: "trigger.nope" }), m)).toEqual([
      issue({ code: "ref.unresolved", field: "trigger.dedupeKey", severity: "error" }),
    ]);
    expect(validateWorkflow(doc({ $ref: "trigger.meta" }), m)).toEqual([
      issue({ code: "ref.typeMismatch", field: "trigger.dedupeKey", severity: "warning" }),
    ]);
    for (const bad of [{ $ref: "loop.index" }, { $tpl: "{{ run.id }}" }, { $ref: "steps.u.id" }]) {
      expect(validateWorkflow(doc(bad), m)).toEqual([
        issue({ code: "config.invalid", field: "trigger.dedupeKey", severity: "error" }),
      ]);
    }
  });

  test("tuples: extra items and wrong item types are config.invalid, never a crash", () => {
    const m = extend([tupleNode]);
    const doc = (pair: Step["config"][string]) => docWith([step("t", "x.tuple", { pair })]);
    expect(validateWorkflow(doc(["a", 1]), m)).toEqual([]);
    expect(validateWorkflow(doc(["a", 1, "extra"]), m)).toEqual([
      issue({ code: "config.invalid", field: "pair", severity: "error" }),
    ]);
    expect(validateWorkflow(doc(["a", "b"]), m)).toEqual([
      issue({ code: "config.invalid", field: "pair[1]" }),
    ]);
  });

  test("never throws on unexpected schema shapes: internal failures become warnings", () => {
    const weird: JSONSchema = { type: "string" };
    Object.defineProperty(weird, "minLength", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    const node: NodeManifest = {
      type: "x.weird",
      plugin: "x",
      name: "Weird",
      input: {
        type: "object",
        properties: { a: weird, b: { type: "string" }, c: false, d: true, e: { items: 5 } },
      },
      output: { kind: "schema", schema: {} },
      branches: { kind: "none" },
    };
    const m = { ...manifest, nodes: [...manifest.nodes, node] };
    const doc = docWith([step("w", "x.weird", { a: "x", b: 1, c: "y", d: "z", e: [1] })]);
    let issues: Issue[] = [];
    expect(() => {
      issues = validateWorkflow(doc, m);
    }).not.toThrow();
    expect(issues).toEqual([
      issue({
        code: "config.invalid",
        stepId: "w",
        field: "a",
        severity: "warning",
        message: expect.stringContaining("Could not validate field"),
      }),
      issue({ code: "config.invalid", field: "b", severity: "error" }),
      issue({ code: "config.invalid", field: "c", severity: "error" }),
    ]);
  });

  test("nested $defs inside a field schema are resolved against the input root", () => {
    const node: NodeManifest = {
      type: "x.defs",
      plugin: "x",
      name: "Defs",
      input: {
        type: "object",
        properties: { addr: { $ref: "#/$defs/Addr" } },
        $defs: {
          Addr: { type: "object", properties: { city: { $ref: "#/$defs/Num" } } },
          Num: { type: "number" },
        },
      },
      output: { kind: "schema", schema: {} },
      branches: { kind: "none" },
    };
    const m = { ...manifest, nodes: [...manifest.nodes, node] };
    const doc = docWith([
      step("load", "crm.loadContact", { contactId: "c1" }),
      step("d", "x.defs", { addr: { $ref: "steps.load.address" } }),
    ]);
    const issues = validateWorkflow(doc, m);
    expect(issues).toEqual([issue({ code: "ref.typeMismatch", field: "addr" })]);
    expect(issues[0]!.message).toBe(
      '"addr" expects { city } but steps.load.address is { city, zip }',
    );
    // literal nested values too
    const lit = docWith([step("d", "x.defs", { addr: { city: "Paris" } })]);
    expect(validateWorkflow(lit, m)).toEqual([
      issue({ code: "config.invalid", field: "addr.city" }),
    ]);
  });

  test("a typo'd path into a disabled step is still ref.unresolved (error)", () => {
    const doc = fixtureDoc();
    doc.steps[0]!.disabled = true;
    doc.steps[1]!.config.to = { $ref: "steps.load.emial" };
    expect(validateWorkflow(doc, manifest)).toContainEqual(
      issue({ code: "ref.unresolved", stepId: "email", field: "to", severity: "error" }),
    );
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

  test("a sub-flow's output mapping must provide its declared outputs, with matching types", () => {
    const sub = defineTrigger({
      type: "x.sub",
      name: "Sub",
      kind: "subflow",
      config: z.object({ output: z.array(z.unknown()).default([]) }),
      payload: z.object({ email: z.string() }),
    });
    const m = extend([], [sub]);
    const doc = docWith([step("load", "crm.loadContact", { contactId: "c1" })], {
      type: "x.sub",
      config: {
        output: [
          { name: "email", type: "string", required: true },
          { name: "count", type: "number", required: true },
          { name: "note", type: "string" },
        ],
      },
    });
    expect(validateWorkflow(doc, m)).toEqual([
      issue({ code: "config.required", field: "output.email", message: '"email" is required' }),
      issue({ code: "config.required", field: "output.count" }),
    ]);
    doc.output = { email: { $ref: "steps.load.email" }, count: { $ref: "steps.load.email" } };
    expect(validateWorkflow(doc, m)).toEqual([
      issue({ code: "ref.typeMismatch", field: "output.count", severity: "warning" }),
    ]);
    doc.output = { email: { $ref: "steps.load.nope" }, count: 2 };
    expect(validateWorkflow(doc, m)).toEqual([
      issue({ code: "ref.unresolved", field: "output.email" }),
    ]);
  });

  test("fields hidden by showIf are neither required nor checked", () => {
    const n = defineNode({
      type: "x.body",
      name: "Body",
      input: z.object({
        kind: z.enum(["none", "json"]).default("none"),
        body: ui(z.string().min(1), { showIf: { field: "kind", notEquals: "none" } }).optional(),
        // Shown while `body` is set, so hidden whenever `body` is hidden (a chain).
        note: ui(z.string(), { showIf: { field: "body" } }).optional(),
      }),
      run: () => ({}),
    });
    const m = extend([n]);
    const at = (config: Step["config"]) =>
      validateWorkflow(docWith([step("b", "x.body", config)]), m);
    expect(at({})).toEqual([]);
    expect(at({ kind: "none", body: { $ref: "steps.ghost" }, note: 5 })).toEqual([]);
    const fieldsOf = (issues: Issue[]) => issues.map((i) => i.field);
    expect(fieldsOf(at({ kind: "json", body: 5 }))).toEqual(["body"]);
    expect(fieldsOf(at({ kind: "json", body: "x", note: 5 }))).toEqual(["note"]);
    // A reference in the sibling can't be known in advance: the field applies.
    expect(fieldsOf(at({ kind: { $ref: "trigger.kind" }, body: 5 }))).toContain("body");
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

  test("a valid union member in a disabled step reports nothing", () => {
    const authNode = defineNode({
      type: "x.auth",
      name: "Auth",
      input: z.object({
        auth: z.discriminatedUnion("type", [
          z.object({ type: z.literal("none") }),
          z.object({ type: z.literal("bearer"), secret: z.string() }),
        ]),
      }),
      run: () => ({}),
    });
    const m = extend([authNode]);
    const valid = { auth: { type: "bearer", secret: "TOKEN" } };
    const bad = { auth: { type: "bearer" } };
    const docOf = (config: Step["config"]) =>
      docWith([step("a", "x.auth", config, { disabled: true })]);
    expect(validateWorkflow(docOf(valid), m)).toEqual([]);
    const issues = validateWorkflow(docOf(bad), m);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.severity === "warning")).toBe(true);
  });

  test("a discriminated union checks the member its discriminator names", () => {
    const authNode = defineNode({
      type: "x.auth",
      name: "Auth",
      input: z.object({
        auth: z.discriminatedUnion("type", [
          z.object({ type: z.literal("none") }),
          z.object({ type: z.literal("bearer"), secret: z.string() }),
          z.object({ type: z.literal("header"), name: z.string(), secret: z.string() }),
        ]),
      }),
      run: () => ({}),
    });
    const m = extend([authNode]);
    const issuesOf = (auth: unknown) =>
      validateWorkflow(docWith([step("a", "x.auth", { auth } as Step["config"])]), m).map((i) => [
        i.code,
        i.field,
      ]);
    expect(issuesOf({ type: "bearer" })).toEqual([["config.required", "auth.secret"]]);
    expect(issuesOf({ type: "header", secret: "S" })).toEqual([["config.required", "auth.name"]]);
    // No member matches the discriminator: the closest member still decides.
    expect(issuesOf({ type: "nope" }).length).toBeGreaterThan(0);
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
    // Best of several runs: robust to CI/parallel-load noise, still catches algorithmic regressions.
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      validateWorkflow(doc, manifest);
      best = Math.min(best, performance.now() - start);
    }
    expect(best).toBeLessThan(20);
  });
});

test("hasErrors", () => {
  expect(hasErrors([])).toBe(false);
  expect(hasErrors([{ code: "doc.empty", severity: "warning", message: "" }])).toBe(false);
  expect(hasErrors([{ code: "node.unknown", severity: "error", message: "" }])).toBe(true);
});

describe("oneOfRequired", () => {
  const wait = defineNode({
    type: "x.wait",
    name: "Wait",
    input: ui(
      z.object({
        duration: ui(z.string(), { label: "Wait for" }).optional(),
        until: ui(z.string(), { label: "Wait until" }).optional(),
      }),
      { oneOfRequired: [["duration"], ["until"]] },
    ),
    run: () => ({}),
  });
  const window = defineNode({
    type: "x.window",
    name: "Window",
    input: ui(
      z.object({
        from: z.string().optional(),
        to: z.string().optional(),
        preset: ui(z.string(), { label: "Preset" }).optional(),
        tag: z.string().optional(),
      }),
      { oneOfRequired: [["from", "to"], ["preset"], ["tag"]] },
    ),
    run: () => ({}),
  });
  const m = extend([wait, window]);
  const check = (type: string, config: Step["config"]) =>
    validateWorkflow(docWith([step("s", type, config)]), m);

  test("passes when exactly one group is set", () => {
    expect(check("x.wait", { duration: "5m" })).toEqual([]);
    expect(check("x.wait", { until: { $ref: "trigger.contactId" } })).toEqual([]);
    expect(check("x.window", { from: "a", to: "b" })).toEqual([]);
  });

  test("reports config.required when no group is set", () => {
    expect(check("x.wait", {})).toEqual([
      issue({
        code: "config.required",
        severity: "error",
        stepId: "s",
        field: "duration",
        message: 'Set "Wait for" or "Wait until"',
      }),
    ]);
    // An empty string doesn't count, and a group needs all of its fields.
    expect(check("x.window", { preset: "", from: "a" })).toEqual([
      issue({ code: "config.required", message: 'Set "from" and "to", "Preset" or "tag"' }),
    ]);
  });

  test("reports config.required when several groups are set", () => {
    expect(check("x.wait", { duration: "5m", until: "2026-01-01T00:00:00Z" })).toEqual([
      issue({
        code: "config.required",
        field: "until",
        message: 'Set either "Wait for" or "Wait until", not both',
      }),
    ]);
    expect(check("x.window", { from: "a", to: "b", preset: "p", tag: "t" })).toEqual([
      issue({ message: 'Set only one of "from" and "to", "Preset" or "tag"' }),
    ]);
  });

  test("ignores malformed groups", () => {
    const odd = defineNode({
      type: "x.odd",
      name: "Odd",
      input: z.object({ a: z.string().optional() }).meta({
        [UI_META_KEY]: { oneOfRequired: [[], [1], "a"] },
      }),
      run: () => ({}),
    });
    expect(validateWorkflow(docWith([step("s", "x.odd", {})]), extend([odd]))).toEqual([]);
  });
});

describe("warnIfEmpty", () => {
  const tags = defineNode({
    type: "x.tags",
    name: "Tags",
    input: z.object({
      tags: ui(z.array(z.string()), {
        label: "Tags",
        warnIfEmpty: "No tags, so nothing is tagged",
      }),
    }),
    run: () => ({}),
  });
  const m = extend([tags]);

  test("warns on a literal empty list only", () => {
    const empty = validateWorkflow(docWith([step("s", "x.tags", { tags: [] })]), m);
    expect(empty).toEqual([
      issue({
        code: "config.empty",
        severity: "warning",
        field: "tags",
        message: "No tags, so nothing is tagged",
      }),
    ]);
    expect(hasErrors(empty)).toBe(false);
    expect(validateWorkflow(docWith([step("s", "x.tags", { tags: ["a"] })]), m)).toEqual([]);
    expect(
      validateWorkflow(docWith([step("s", "x.tags", { tags: { $ref: "trigger.tags" } })]), m),
    ).not.toContainEqual(issue({ code: "config.empty" }));
  });
});

describe("checkJson", () => {
  const body: JSONSchema = {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["approved", "rejected"] },
      note: { type: "string", maxLength: 5 },
    },
    required: ["decision"],
    additionalProperties: false,
  };

  test("accepts a matching value", () => {
    expect(checkJson({ decision: "approved" }, body)).toEqual([]);
  });

  test("reports required, enum, length and unknown-key problems", () => {
    expect(checkJson({}, body)).toEqual(['"decision" is required']);
    expect(checkJson({ decision: "maybe", note: "too long", x: 1 }, body)).toEqual([
      '"decision" must be one of: "approved", "rejected"',
      '"note" must be at most 5 characters',
      '"x" is not a known field',
    ]);
    expect(checkJson([], body, "Body")).toEqual(['"Body" must be an object']);
  });

  test("a missing value is required unless the schema accepts anything", () => {
    expect(checkJson(undefined, body, "Body")).toEqual(['"Body" is required']);
    expect(checkJson(undefined, {})).toEqual([]);
  });

  test("treats $ref and $tpl objects as plain data", () => {
    const schema: JSONSchema = { type: "object", properties: { $ref: { type: "number" } } };
    expect(checkJson({ $ref: "steps.a" }, schema)).toEqual(['"$ref" must be a number']);
    expect(checkJson({ $tpl: "{{x}}" }, { type: "object" })).toEqual([]);
  });
});
