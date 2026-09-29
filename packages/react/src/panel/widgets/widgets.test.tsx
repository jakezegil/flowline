import {
  availableScope,
  createRegistry,
  defineTrigger,
  type JSONSchema,
  type Manifest,
  type ValueExpr,
  validateWorkflow,
  type WorkflowDoc,
} from "@flowlinejs/core";
import { type BuiltinOptions, createBuiltinPlugin } from "@flowlinejs/nodes-builtin";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { type JSX, useState } from "react";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import builtin from "../../../playground/builtin-manifest.json";
import { editorView, setupCodeMirrorDom, typeInto } from "../../../test/codemirror-dom";
import { mockClient } from "../../../test/dom";
import { FlowlineProvider } from "../../provider";
import { SchemaForm } from "../schema-form";
import { literalTypeIssue, toTypedList, toTypedLiteral } from "./literal";

beforeAll(setupCodeMirrorDom);
afterEach(cleanup);

const core = builtin as unknown as Manifest;
const inputOf = (type: string, m: Manifest = core) =>
  m.nodes.find((n) => n.type === type)?.input as JSONSchema;
const triggerConfigOf = (type: string) =>
  core.triggers.find((t) => t.type === type)?.config as JSONSchema;

type Value = Record<string, ValueExpr>;
let latest: Value = {};

const MANUAL: WorkflowDoc["trigger"] = {
  type: "core.manual",
  config: {
    fields: [
      { name: "amount", type: "number" },
      { name: "email", type: "string" },
    ],
  },
};
/** A trigger whose payload is `{ deal: { amount: number, won: boolean, stage: string } }`. */
const DEAL: WorkflowDoc["trigger"] = { type: "crm.dealUpdated", config: {} };

function docWith(stepType: string, config: Value, trigger = MANUAL): WorkflowDoc {
  return {
    id: "wf",
    name: "Test",
    trigger,
    steps: [{ id: "s", type: stepType, config }],
  };
}

const crmPlugin = {
  id: "crm",
  name: "CRM",
  triggers: [
    defineTrigger({
      type: "crm.dealUpdated",
      name: "Deal updated",
      kind: "event",
      event: "deal.updated",
      config: z.object({}),
      payload: z.object({
        deal: z.object({ amount: z.number(), won: z.boolean(), stage: z.string() }),
      }),
    }),
  ],
};

/** A manifest with the builtin plugin built with `opts`, plus a deal trigger. */
function manifestWith(opts: BuiltinOptions = {}): Manifest {
  return createRegistry([createBuiltinPlugin(opts), crmPlugin]).manifest();
}

function Form({
  schema,
  initial,
  stepType,
  manifest,
  trigger,
}: {
  schema: JSONSchema;
  initial: Value;
  stepType: string;
  manifest: Manifest;
  trigger: WorkflowDoc["trigger"];
}): JSX.Element {
  const [value, setValue] = useState<Value>(initial);
  latest = value;
  const scope = availableScope(docWith(stepType, value, trigger), "s", manifest);
  return (
    <SchemaForm
      schema={schema}
      value={value}
      onChange={(k, v) =>
        setValue((prev) => {
          const next = { ...prev };
          if (v === undefined) delete next[k];
          else next[k] = v;
          return next;
        })
      }
      stepId="s"
      issues={[]}
      scope={scope}
      samples={{}}
    />
  );
}

function renderWidget(stepType: string, initial: Value, schema = inputOf(stepType)) {
  latest = initial;
  return render(
    <FlowlineProvider client={mockClient()}>
      <Form
        schema={schema}
        initial={initial}
        stepType={stepType}
        manifest={core}
        trigger={MANUAL}
      />
    </FlowlineProvider>,
  );
}

/** Renders `stepType`'s form under a deal trigger, with the builtin plugin built with `opts`. */
function renderDeal(stepType: string, initial: Value, opts: BuiltinOptions = {}) {
  latest = initial;
  const manifest = manifestWith(opts);
  return render(
    <FlowlineProvider client={mockClient()}>
      <Form
        schema={inputOf(stepType, manifest)}
        initial={initial}
        stepType={stepType}
        manifest={manifest}
        trigger={DEAL}
      />
    </FlowlineProvider>,
  );
}

const amount = { $ref: "trigger.deal.amount" };
const won = { $ref: "trigger.deal.won" };
const stage = { $ref: "trigger.deal.stage" };

/** Replaces the text of the editor labelled `label`, typing it as a user would. */
function retype(label: string, text: string) {
  const view = editorView(label);
  act(() => {
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    typeInto(view, text);
  });
}

type RuleValue = { rules: Record<string, unknown>[]; compare?: string };
const rulesOf = () => latest.rules as unknown as RuleValue;

const optionNames = (select: HTMLElement) =>
  Array.from((select as HTMLSelectElement).options).map((o) => o.textContent);

describe("rules widget", () => {
  const start = (rules: unknown[]) => ({
    rules: { combinator: "and", rules } as unknown as ValueExpr,
  });

  test("builds a rule group that validates against the condition node", () => {
    renderWidget("core.condition", start([]));
    expect(screen.getByText(/No rules yet/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    fireEvent.click(screen.getByRole("button", { name: "Add group" }));
    fireEvent.click(screen.getAllByRole("radio", { name: "Any rule" })[0] as HTMLElement);
    // Rules inside a nested group are named after it, so every name is unique.
    expect(screen.getByRole("combobox", { name: "Group 2, Value 1: Operator" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Value 1: Operator" }), {
      target: { value: "isNotEmpty" },
    });

    expect(latest.rules).toEqual({
      combinator: "or",
      rules: [
        { left: "", op: "isNotEmpty" },
        { combinator: "or", rules: [{ left: "", op: "eq", right: "" }] },
      ],
    });
    // Structurally valid: only the empty left-hand values are left to fill in.
    const issues = validateWorkflow(docWith("core.condition", latest), core);
    expect(issues.filter((i) => i.field !== undefined && i.code !== "config.required")).toEqual([]);
  });

  test("unary operators hide the right-hand value", () => {
    renderWidget(
      "core.condition",
      start([{ left: { $ref: "trigger.email" }, op: "eq", right: "x" }]),
    );
    expect(screen.getByRole("textbox", { name: "Value 1: Compare with" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Value 1: Operator" }), {
      target: { value: "isEmpty" },
    });
    expect(screen.queryByRole("textbox", { name: "Value 1: Compare with" })).toBeNull();
  });

  test("operators follow the type of the left-hand value", () => {
    renderWidget(
      "core.condition",
      start([
        { left: { $ref: "trigger.amount" }, op: "gt", right: "10" },
        { left: { $ref: "trigger.email" }, op: "contains", right: "@" },
      ]),
    );
    const [num, text] = screen.getAllByRole("combobox", { name: /Operator/ });
    expect(optionNames(num as HTMLElement)).toContain("is greater than");
    expect(optionNames(num as HTMLElement)).not.toContain("contains");
    expect(optionNames(text as HTMLElement)).toContain("contains");
    // Text comparisons offer "Match case".
    const matchCase = screen.getByRole("button", { name: "Value 2: Match case" });
    fireEvent.click(matchCase);
    expect((latest.rules as { rules: { caseSensitive?: boolean }[] }).rules[1]?.caseSensitive).toBe(
      true,
    );
  });

  test("rules can be reordered and removed", () => {
    renderWidget(
      "core.condition",
      start([
        { left: "a", op: "isTrue" },
        { left: "b", op: "isFalse" },
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Move down: Value 1" }));
    expect((latest.rules as { rules: { left: string }[] }).rules.map((r) => r.left)).toEqual([
      "b",
      "a",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Remove: Value 1" }));
    expect((latest.rules as { rules: { left: string }[] }).rules.map((r) => r.left)).toEqual(["a"]);
  });
});

describe("typed literals", () => {
  test("text becomes a literal of the left-hand type", () => {
    expect(toTypedLiteral("5", "number")).toBe(5);
    expect(toTypedLiteral(" -2.5 ", "number")).toBe(-2.5);
    expect(toTypedLiteral("abc", "number")).toBe("abc");
    expect(toTypedLiteral("", "number")).toBe("");
    expect(toTypedLiteral("true", "boolean")).toBe(true);
    expect(toTypedLiteral("false", "boolean")).toBe(false);
    expect(toTypedLiteral("yes", "boolean")).toBe("yes");
    expect(toTypedLiteral("5", "string")).toBe("5");
    expect(toTypedLiteral("5", "any")).toBe("5");
    expect(toTypedList("5, 7", "number")).toEqual([5, 7]);
    expect(toTypedList("won, lost,", "string")).toEqual(["won", "lost"]);
    expect(toTypedList("5, x", "number")).toEqual([5, "x"]);
  });

  test("rule.literalType warns about a literal of another type, in strict mode only", () => {
    const rule = { left: amount, op: "eq", right: "5" };
    expect(literalTypeIssue(rule, "number", "loose")).toBeUndefined();
    expect(literalTypeIssue(rule, "number", "strict")).toMatchObject({
      code: "rule.literalType",
      severity: "warning",
    });
    expect(literalTypeIssue({ ...rule, right: 5 }, "number", "strict")).toBeUndefined();
    expect(literalTypeIssue({ ...rule, right: "" }, "number", "strict")).toBeUndefined();
    expect(literalTypeIssue({ ...rule, right: stage }, "number", "strict")).toBeUndefined();
    expect(literalTypeIssue({ ...rule, op: "isEmpty" }, "number", "strict")).toBeUndefined();
    const list = { ...rule, op: "in" };
    expect(literalTypeIssue({ ...list, right: [5, 7] }, "number", "strict")).toBeUndefined();
    expect(literalTypeIssue({ ...list, right: "5, 7" }, "number", "strict")).toBeDefined();
    expect(literalTypeIssue({ ...list, right: [5, "7"] }, "number", "strict")).toBeDefined();
    expect(literalTypeIssue({ ...rule, right: 5 }, "string", "strict")).toBeDefined();
    expect(literalTypeIssue({ ...rule, right: "true" }, "boolean", "strict")).toBeDefined();
    expect(literalTypeIssue(rule, "any", "strict")).toBeUndefined();
    // Host operators decide their own types.
    expect(literalTypeIssue({ ...rule, op: "isUnassigned" }, "number", "strict")).toBeUndefined();
  });
});

describe("rules widget: compare modes and typed literals", () => {
  const start = (rules: unknown[]) => ({
    rules: { combinator: "and", rules } as unknown as ValueExpr,
  });
  const warning = /strict mode will never match/i;

  test("a number field stores numbers; other text stays text and is flagged in strict mode", () => {
    renderDeal("core.condition", start([{ left: amount, op: "eq", right: "" }]));
    retype("Value 1: Compare with", "5");
    expect(rulesOf().rules[0]).toEqual({ left: amount, op: "eq", right: 5 });
    retype("Value 1: Compare with", "abc");
    expect(rulesOf().rules[0]?.right).toBe("abc");
    // Loose (the default) compares "abc" loosely: nothing to warn about.
    expect(screen.queryByText(warning)).toBeNull();

    fireEvent.change(screen.getByRole("combobox", { name: "Conditions: Compare" }), {
      target: { value: "strict" },
    });
    expect(rulesOf().compare).toBe("strict");
    expect(screen.getByText(warning)).toBeTruthy();
    retype("Value 1: Compare with", "12");
    expect(rulesOf().rules[0]?.right).toBe(12);
    expect(screen.queryByText(warning)).toBeNull();
  });

  test("a true/false field takes a true/false choice", () => {
    renderDeal("core.condition", start([{ left: won, op: "eq", right: "" }]));
    const choice = screen.getByRole("combobox", { name: "Value 1: Compare with" });
    fireEvent.change(choice, { target: { value: "true" } });
    expect(rulesOf().rules[0]?.right).toBe(true);
    fireEvent.change(choice, { target: { value: "false" } });
    expect(rulesOf().rules[0]?.right).toBe(false);
  });

  test("'is one of' stores a list typed like the left-hand value", () => {
    renderDeal(
      "core.condition",
      start([
        { left: amount, op: "in", right: "" },
        { left: stage, op: "in", right: "" },
      ]),
    );
    retype("Value 1: Compare with", "5, 7");
    retype("Value 2: Compare with", "a, b");
    expect(rulesOf().rules.map((r) => r.right)).toEqual([
      [5, 7],
      ["a", "b"],
    ]);
  });

  test("the Compare select starts at the schema default and strict hides Match case", () => {
    renderDeal("core.condition", start([{ left: stage, op: "contains", right: "x" }]), {
      compare: "strict",
    });
    const compare = screen.getByRole("combobox", { name: "Conditions: Compare" });
    expect((compare as HTMLSelectElement).value).toBe("strict");
    expect(screen.getByText(/^Values of the same type only/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Value 1: Match case" })).toBeNull();
    // Rendering alone writes nothing.
    expect(rulesOf().compare).toBeUndefined();
    cleanup();

    renderDeal(
      "core.condition",
      start([
        { left: stage, op: "contains", right: "x", caseSensitive: true },
        {
          combinator: "or",
          rules: [{ left: stage, op: "eq", right: "y", caseSensitive: true }],
        },
      ]),
    );
    const loose = screen.getByRole("combobox", { name: "Conditions: Compare" });
    expect((loose as HTMLSelectElement).value).toBe("loose");
    expect(screen.getByRole("button", { name: "Value 1: Match case" })).toBeTruthy();
    fireEvent.change(loose, { target: { value: "strict" } });
    expect(screen.queryByRole("button", { name: "Value 1: Match case" })).toBeNull();
    // Strict always matches case, so the flags go (nested groups included).
    expect(rulesOf()).toEqual({
      combinator: "and",
      compare: "strict",
      rules: [
        { left: stage, op: "contains", right: "x" },
        { combinator: "or", rules: [{ left: stage, op: "eq", right: "y" }] },
      ],
    });
  });

  test("host operators are offered by label for the types they declare", () => {
    renderDeal(
      "core.condition",
      start([
        { left: stage, op: "eq", right: "x" },
        { left: amount, op: "eq", right: 5 },
      ]),
      {
        operators: [
          {
            id: "isUnassigned",
            label: "is unassigned",
            arity: "unary",
            types: ["string"],
            evaluate: (left) => left === "",
          },
        ],
      },
    );
    const text = screen.getByRole("combobox", { name: "Value 1: Operator" });
    const num = screen.getByRole("combobox", { name: "Value 2: Operator" });
    expect(optionNames(text)).toContain("is unassigned");
    expect(optionNames(num)).not.toContain("is unassigned");
    fireEvent.change(text, { target: { value: "isUnassigned" } });
    expect(rulesOf().rules[0]).toEqual({ left: stage, op: "isUnassigned" });
    expect(screen.queryByRole("textbox", { name: "Value 1: Compare with" })).toBeNull();
  });

  test("existing text literals render as before in loose mode", () => {
    const initial = start([
      { left: amount, op: "gt", right: "10" },
      { left: stage, op: "in", right: "won, lost" },
      { left: stage, op: "eq", right: "Won", caseSensitive: true },
    ]);
    const { container } = renderDeal("core.condition", initial);
    const rows = Array.from(container.querySelectorAll(".fl-rule"), (row) => ({
      op: (row.querySelector(".fl-rule__op") as HTMLSelectElement).value,
      right: row.querySelectorAll(".cm-content")[1]?.textContent,
      matchCase: row.querySelector(".fl-rule__case")?.getAttribute("aria-pressed"),
    }));
    expect(rows).toMatchInlineSnapshot(`
      [
        {
          "matchCase": undefined,
          "op": "gt",
          "right": "10",
        },
        {
          "matchCase": "false",
          "op": "in",
          "right": "won, lost",
        },
        {
          "matchCase": "true",
          "op": "eq",
          "right": "Won",
        },
      ]
    `);
    expect(screen.queryByText(warning)).toBeNull();
    expect(latest).toEqual(initial);
  });
});

describe("cases widget", () => {
  test("case values are typed like the switch value, with a Compare choice", () => {
    renderDeal(
      "core.switch",
      { value: amount, cases: [{ id: "big", label: "Big", value: "" }] },
      { compare: "strict" },
    );
    const compare = screen.getByRole("radiogroup", { name: "Compare" });
    const strict = within(compare).getByRole("radio", { name: "Strict" });
    expect(strict.getAttribute("aria-checked")).toBe("true");
    retype("Big: Matches", "5");
    expect(latest.cases).toEqual([{ id: "big", label: "Big", value: 5 }]);
    retype("Big: Matches", "five");
    expect(screen.getByText(/strict mode will never match/i)).toBeTruthy();
    fireEvent.click(within(compare).getByRole("radio", { name: "Loose" }));
    expect(screen.queryByText(/strict mode will never match/i)).toBeNull();
  });

  test("a true/false switch value takes true/false cases", () => {
    renderDeal("core.switch", { value: won, cases: [{ id: "yes", label: "Yes", value: "" }] });
    fireEvent.change(screen.getByRole("combobox", { name: "Yes: Matches" }), {
      target: { value: "true" },
    });
    expect(latest.cases).toEqual([{ id: "yes", label: "Yes", value: true }]);
  });

  test("a new case's ID follows its name; existing IDs never change", () => {
    renderWidget("core.switch", {
      value: { $ref: "trigger.email" },
      cases: [{ id: "gold", label: "Gold", value: "gold" }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Add case" }));
    const names = screen.getAllByRole("textbox", { name: /^Case name \d+$/ });
    fireEvent.change(names[1] as HTMLElement, { target: { value: "Silver tier" } });
    fireEvent.change(names[0] as HTMLElement, { target: { value: "Gold tier" } });
    expect(latest.cases).toEqual([
      { id: "gold", label: "Gold tier", value: "gold" },
      { id: "silver_tier", label: "Silver tier", value: "" },
    ]);
    expect(screen.getByText("Path ID silver_tier")).toBeTruthy();
  });

  test("IDs stay unique and never take the reserved default path", () => {
    renderWidget("core.switch", { value: "x", cases: [{ id: "gold", label: "Gold", value: "1" }] });
    fireEvent.click(screen.getByRole("button", { name: "Add case" }));
    fireEvent.click(screen.getByRole("button", { name: "Add case" }));
    const names = screen.getAllByRole("textbox", { name: /^Case name \d+$/ });
    fireEvent.change(names[1] as HTMLElement, { target: { value: "Gold" } });
    fireEvent.change(names[2] as HTMLElement, { target: { value: "Default" } });
    const ids = (latest.cases as { id: string }[]).map((c) => c.id);
    expect(ids).toEqual(["gold", "gold_2", "default_2"]);
  });
});

describe("fields widget", () => {
  test("declares fields with a name, type, required flag and description", () => {
    renderWidget("", { fields: [] }, triggerConfigOf("core.manual"));
    fireEvent.click(screen.getByRole("button", { name: "Add field" }));
    const list = screen.getByRole("list");
    fireEvent.change(within(list).getByRole("textbox", { name: "Field name 1" }), {
      target: { value: "seats" },
    });
    fireEvent.change(within(list).getByRole("combobox", { name: /Type/ }), {
      target: { value: "number" },
    });
    fireEvent.click(within(list).getByRole("switch", { name: /Required/ }));
    expect(latest.fields).toEqual([{ name: "seats", type: "number", required: true }]);
  });

  test("flags invalid and duplicate names", () => {
    renderWidget(
      "",
      {
        fields: [
          { name: "a", type: "string" },
          { name: "a", type: "string" },
          { name: "2x", type: "string" },
        ],
      },
      triggerConfigOf("core.manual"),
    );
    expect(screen.getAllByText("Another field has this name")).toHaveLength(2);
    expect(screen.getByText(/Use letters, digits and _/)).toBeTruthy();
  });
});
