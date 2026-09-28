import {
  availableScope,
  type JSONSchema,
  type Manifest,
  type ValueExpr,
  validateWorkflow,
  type WorkflowDoc,
} from "@flowlinejs/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { type JSX, useState } from "react";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import builtin from "../../../playground/builtin-manifest.json";
import { mockClient, setupDom } from "../../../test/dom";
import { FlowlineProvider } from "../../provider";
import { SchemaForm } from "../schema-form";

beforeAll(setupDom);
afterEach(cleanup);

const core = builtin as unknown as Manifest;
const inputOf = (type: string) => core.nodes.find((n) => n.type === type)?.input as JSONSchema;
const triggerConfigOf = (type: string) =>
  core.triggers.find((t) => t.type === type)?.config as JSONSchema;

type Value = Record<string, ValueExpr>;
let latest: Value = {};

function docWith(stepType: string, config: Value): WorkflowDoc {
  return {
    id: "wf",
    name: "Test",
    trigger: {
      type: "core.manual",
      config: {
        fields: [
          { name: "amount", type: "number" },
          { name: "email", type: "string" },
        ],
      },
    },
    steps: [{ id: "s", type: stepType, config }],
  };
}

function Form({
  schema,
  initial,
  stepType,
}: {
  schema: JSONSchema;
  initial: Value;
  stepType: string;
}): JSX.Element {
  const [value, setValue] = useState<Value>(initial);
  latest = value;
  const scope = availableScope(docWith(stepType, value), "s", core);
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
      <Form schema={schema} initial={initial} stepType={stepType} />
    </FlowlineProvider>,
  );
}

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

describe("cases widget", () => {
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
