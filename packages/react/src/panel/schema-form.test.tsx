import {
  availableScope,
  type Issue,
  type JSONSchema,
  type Manifest,
  type ScopeEntry,
  type ValueExpr,
} from "@flowlinejs/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type JSX, useState } from "react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import builtin from "../../playground/builtin-manifest.json";
import { editorView, typeInto } from "../../test/codemirror-dom";
import { mockClient, setupDom } from "../../test/dom";
import { fixtureDoc, manifest } from "../../test/fixtures";
import { FlowlineProvider } from "../provider";
import { SchemaForm } from "./schema-form";

beforeAll(setupDom);
afterEach(cleanup);

const core = builtin as unknown as Manifest;
const http = core.nodes.find((n) => n.type === "core.httpRequest")?.input as JSONSchema;
const scope: ScopeEntry[] = availableScope(fixtureDoc(), "email", manifest);

type Value = Record<string, ValueExpr>;
let latest: Value = {};

function Form(props: {
  schema: JSONSchema;
  initial?: Value;
  issues?: Issue[];
  readOnly?: boolean;
  literalOnly?: boolean;
}): JSX.Element {
  const [value, setValue] = useState<Value>(props.initial ?? {});
  latest = value;
  return (
    <SchemaForm
      schema={props.schema}
      value={value}
      onChange={(key, v) =>
        setValue((prev) => {
          const next = { ...prev };
          if (v === undefined) delete next[key];
          else next[key] = v;
          return next;
        })
      }
      stepId="email"
      issues={props.issues ?? []}
      scope={scope}
      samples={{}}
      {...(props.readOnly ? { readOnly: true } : {})}
      {...(props.literalOnly ? { literalOnly: true } : {})}
    />
  );
}

function renderForm(
  props: Parameters<typeof Form>[0],
  client = mockClient({ listSecrets: async () => ["API_TOKEN", "OTHER"] }),
) {
  latest = props.initial ?? {};
  return render(
    <FlowlineProvider client={client}>
      <Form {...props} />
    </FlowlineProvider>,
  );
}

/** The field frame around a control. */
const fieldOf = (el: HTMLElement) => el.closest<HTMLElement>(".fl-f") as HTMLElement;

const mixed: JSONSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "Shown to the assignee",
      "x-flowline": { label: "Task title" },
    },
    notify: { type: "boolean", "x-flowline": { label: "Notify owner" } },
    retries: { type: "integer", "x-flowline": { label: "Retries" } },
    priority: { type: "string", enum: ["low", "normal", "high"], default: "normal" },
    region: {
      type: "string",
      enum: ["emea", "amer", "apac", "latam", "anz"],
      "x-flowline": { label: "Region" },
    },
    internal: { type: "string", "x-flowline": { hidden: true, label: "Internal" } },
    template: { type: "string", "x-flowline": { label: "Template", literalOnly: true } },
  },
  required: ["title"],
};

describe("SchemaForm", () => {
  test("renders a control per field kind, with labels, required marks and help", () => {
    renderForm({ schema: mixed });
    const title = screen.getByRole("textbox", { name: "Task title" });
    expect(fieldOf(title).textContent).toContain("(required)");
    expect(screen.getByText("Shown to the assignee")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Notify owner" })).toBeTruthy();
    expect(screen.getByLabelText("Retries")).toBeTruthy();
    // Few short options with a default: segmented; many: a select.
    expect(screen.getByRole("radiogroup", { name: "Priority" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Region" })).toBeTruthy();
    expect(screen.queryByText("Internal")).toBeNull();
  });

  test("switches, numbers and choices write typed values", () => {
    renderForm({ schema: mixed });
    fireEvent.click(screen.getByRole("switch", { name: "Notify owner" }));
    expect(latest.notify).toBe(true);

    fireEvent.change(screen.getByLabelText("Retries"), { target: { value: "3" } });
    expect(latest.retries).toBe(3);

    fireEvent.click(screen.getByRole("radio", { name: "High" }));
    expect(latest.priority).toBe("high");

    const region = screen.getByRole("combobox", { name: "Region" });
    fireEvent.change(region, { target: { value: "2" } });
    expect(latest.region).toBe("apac");
    fireEvent.change(region, { target: { value: "" } });
    expect("region" in latest).toBe(false);
  });

  test("arrow keys in a segmented control check the next option and move focus to it", () => {
    renderForm({ schema: mixed });
    const normal = screen.getByRole("radio", { name: "Normal" });
    normal.focus();
    fireEvent.keyDown(normal, { key: "ArrowRight" });
    const high = screen.getByRole("radio", { name: "High" });
    expect(latest.priority).toBe("high");
    expect(document.activeElement).toBe(high);
    expect(high.tabIndex).toBe(0);
    fireEvent.keyDown(high, { key: "Home" });
    expect(latest.priority).toBe("low");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Low" }));
  });

  test("a number that isn't one is flagged and not written", () => {
    renderForm({ schema: mixed, initial: { retries: 2 } });
    fireEvent.change(screen.getByLabelText("Retries"), { target: { value: "1.5" } });
    expect(screen.getByText("Enter a number")).toBeTruthy();
    expect(latest.retries).toBe(2);
  });

  test("a literal field toggles to a reference and back, keeping the literal", () => {
    renderForm({ schema: mixed, initial: { retries: 5 } });
    const field = fieldOf(screen.getByLabelText("Retries"));
    const toggle = within(field).getByRole("button", { name: "Use data from earlier steps" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(latest.retries).toBeUndefined();
    expect(within(field).getByRole("textbox", { name: "Retries" })).toBeTruthy();
    fireEvent.click(toggle);
    expect(latest.retries).toBe(5);
  });

  test("a stored reference opens in reference mode", () => {
    renderForm({ schema: mixed, initial: { retries: { $ref: "steps.load.id" } } });
    const toggle = within(fieldOf(screen.getByRole("textbox", { name: "Retries" }))).getByRole(
      "button",
      { name: "Use data from earlier steps" },
    );
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  test("literal-only fields offer no reference toggle", () => {
    renderForm({ schema: mixed });
    const field = fieldOf(screen.getByRole("textbox", { name: "Template" }));
    expect(within(field).queryByRole("button", { name: "Use data from earlier steps" })).toBeNull();
  });

  test("M14: a literal-only form (the trigger's) has no reference toggles or picker", () => {
    renderForm({ schema: mixed, literalOnly: true });
    expect(screen.queryAllByRole("button", { name: "Use data from earlier steps" })).toEqual([]);
    const title = screen.getByRole("textbox", { name: "Task title" });
    fireEvent.focus(title);
    expect(screen.queryByRole("tree")).toBeNull();
    expect(fieldOf(title).querySelector(".fl-ref__browse")).toBeNull();
  });

  test("issues show under their field, errors marked invalid", () => {
    renderForm({
      schema: mixed,
      issues: [
        {
          code: "config.required",
          severity: "error",
          message: '"Task title" is required',
          field: "title",
        },
        {
          code: "config.invalid",
          severity: "warning",
          message: "Retries looks high",
          field: "retries",
        },
      ],
    });
    const title = fieldOf(screen.getByRole("textbox", { name: "Task title" }));
    expect(within(title).getByText('"Task title" is required')).toBeTruthy();
    expect(title.hasAttribute("data-invalid")).toBe(true);
    const retries = fieldOf(screen.getByLabelText("Retries"));
    expect(within(retries).getByText("Retries looks high")).toBeTruthy();
    expect(retries.hasAttribute("data-invalid")).toBe(false);
  });

  test("read-only forms disable their controls", () => {
    renderForm({ schema: mixed, readOnly: true });
    expect(
      (screen.getByRole("switch", { name: "Notify owner" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("combobox", { name: "Region" }) as HTMLSelectElement).disabled).toBe(
      true,
    );
  });
});

describe("SchemaForm with the HTTP request schema", () => {
  test("renders the auth union as a variant choice, then that variant's fields", async () => {
    renderForm({ schema: http, initial: { method: "GET", url: "https://x.test" } });
    const auth = screen.getByRole("radiogroup", { name: "Authentication" });
    expect(within(auth).getByRole("radio", { name: "None" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.queryByLabelText(/Secret/)).toBeNull();

    fireEvent.click(within(auth).getByRole("radio", { name: "Bearer" }));
    expect(latest.auth).toEqual({ type: "bearer" });
    const secret = (await screen.findByRole("combobox", { name: /Secret/ })) as HTMLSelectElement;
    await waitFor(() => expect(secret.disabled).toBe(false));
    fireEvent.change(secret, { target: { value: "API_TOKEN" } });
    expect(latest.auth).toEqual({ type: "bearer", secret: "API_TOKEN" });

    // Fields both variants have carry over; the new variant's own fields appear.
    fireEvent.click(within(auth).getByRole("radio", { name: "Header" }));
    expect(latest.auth).toEqual({ type: "header", secret: "API_TOKEN" });
    expect(screen.getByRole("textbox", { name: /Header name/ })).toBeTruthy();

    fireEvent.click(within(auth).getByRole("radio", { name: "None" }));
    expect(latest.auth).toEqual({ type: "none" });
  });

  test("a secret that doesn't exist is shown as missing", async () => {
    renderForm({ schema: http, initial: { auth: { type: "bearer", secret: "GONE" } } });
    expect(await screen.findByRole("option", { name: "GONE (not found)" })).toBeTruthy();
  });

  test("nested issues show under the nested field", () => {
    renderForm({
      schema: http,
      initial: { auth: { type: "bearer" } },
      issues: [
        {
          code: "config.required",
          severity: "error",
          message: '"Secret" is required',
          field: "auth.secret",
        },
      ],
    });
    const secret = screen.getByRole("combobox", { name: /Secret/ });
    expect(within(fieldOf(secret)).getByText('"Secret" is required')).toBeTruthy();
  });

  test("maps edit key/value rows and flag duplicate keys", () => {
    renderForm({ schema: http });
    const headers = screen.getByText("Headers").closest("fieldset") as HTMLElement;
    fireEvent.click(within(headers).getByRole("button", { name: "Add entry" }));
    fireEvent.click(within(headers).getByRole("button", { name: "Add entry" }));
    const keys = within(headers).getAllByRole("textbox", { name: /Headers: Key/ });
    expect(keys).toHaveLength(2);
    fireEvent.change(keys[0] as HTMLElement, { target: { value: "X-Id" } });
    fireEvent.change(keys[1] as HTMLElement, { target: { value: "X-Id" } });
    expect(within(headers).getAllByText("This key is used twice").length).toBeGreaterThan(0);
  });

  test("the Advanced group starts collapsed and opens on click", () => {
    renderForm({ schema: http });
    expect(screen.queryByRole("textbox", { name: "Timeout (ms)" })).toBeNull();
    const toggle = screen.getByRole("button", { name: "Advanced" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByRole("textbox", { name: "Timeout (ms)" })).toBeTruthy();
  });

  test("the Advanced group opens by itself when it holds an issue, and can still be closed", () => {
    renderForm({
      schema: http,
      issues: [
        { code: "config.invalid", severity: "error", message: "Too long", field: "timeoutMs" },
      ],
    });
    expect(screen.getByRole("textbox", { name: "Timeout (ms)" })).toBeTruthy();
    expect(screen.getByText("Too long")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.queryByRole("textbox", { name: "Timeout (ms)" })).toBeNull();
  });

  test("a secret list older than a few seconds is fetched again on focus", async () => {
    const client = mockClient({ listSecrets: async () => ["API_TOKEN"] });
    renderForm({ schema: http, initial: { auth: { type: "bearer" } } }, client);
    const secret = (await screen.findByRole("combobox", { name: /Secret/ })) as HTMLSelectElement;
    await waitFor(() => expect(secret.disabled).toBe(false));
    expect(client.listSecrets).toHaveBeenCalledTimes(1);
    fireEvent.focus(secret);
    expect(client.listSecrets).toHaveBeenCalledTimes(1);
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    try {
      fireEvent.focus(secret);
      await waitFor(() => expect(client.listSecrets).toHaveBeenCalledTimes(2));
    } finally {
      spy.mockRestore();
    }
  });
});

describe("SchemaForm references and JSON", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      extra: {
        type: "object",
        additionalProperties: { type: "string" },
        "x-flowline": { label: "Extra", refOnly: true },
      },
      payload: { "x-flowline": { label: "Payload" } },
    },
  };

  test("a refOnly map takes only a reference", () => {
    renderForm({ schema });
    const field = fieldOf(screen.getByRole("textbox", { name: "Extra" }));
    expect(within(field).queryByRole("button", { name: "Add entry" })).toBeNull();
    expect(within(field).queryByRole("button", { name: "Use data from earlier steps" })).toBeNull();
  });

  test("turning JSON off and on again restores the JSON value", () => {
    renderForm({ schema, initial: { payload: { a: 1 } } });
    const toggle = screen.getByRole("button", { name: "Edit as JSON" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(latest.payload).toBeUndefined();
    fireEvent.click(toggle);
    expect(latest.payload).toEqual({ a: 1 });
  });

  test("references inside JSON show as pills, not raw $ref objects, and edits keep them", () => {
    renderForm({
      schema,
      initial: {
        payload: { to: { $ref: "steps.load.email" }, note: { $tpl: "Hi {{trigger.contactId}}" } },
      },
    });
    const view = editorView("Payload");
    const text = view.dom.textContent ?? "";
    expect(text).not.toContain("$ref");
    expect(text).not.toContain("$tpl");
    expect(view.dom.querySelectorAll(".fl-ref-pill")).toHaveLength(2);
    // Typing elsewhere keeps both references.
    act(() => {
      view.dispatch({ selection: { anchor: 1 } });
      typeInto(view, '\n  "n": 1,');
    });
    expect(latest.payload).toEqual({
      n: 1,
      to: { $ref: "steps.load.email" },
      note: { $tpl: "Hi {{trigger.contactId}}" },
    });
    // Invalid JSON is flagged and not written.
    act(() => typeInto(view, "{"));
    expect(screen.getByText(/valid JSON/i)).toBeTruthy();
    expect(latest.payload).toMatchObject({ n: 1 });
  });

  test("enumLabels override option text; showIf hides a field until its condition holds", () => {
    const s: JSONSchema = {
      type: "object",
      properties: {
        strategy: { enum: ["roundRobin", "team"], default: "roundRobin" },
        team: {
          enum: ["smb", "enterprise"],
          "x-flowline": {
            label: "Team",
            enumLabels: { smb: "SMB" },
            showIf: { field: "strategy", equals: "team" },
          },
        },
      },
    };
    renderForm({ schema: s, initial: { team: "smb" } });
    expect(screen.queryByText("Team", { selector: "label" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Team" }));
    const select = screen.getByRole("combobox", { name: "Team" }) as HTMLSelectElement;
    expect(Array.from(select.options, (o) => o.text)).toContain("SMB");
    expect(Array.from(select.options, (o) => o.text)).toContain("Enterprise");
    // Hiding keeps the value.
    fireEvent.click(screen.getByRole("radio", { name: "Round robin" }));
    expect(screen.queryByRole("combobox", { name: "Team" })).toBeNull();
    expect(latest.team).toBe("smb");
  });

  test("the HTTP body shows only for a body type other than None", () => {
    renderForm({ schema: http, initial: { method: "POST", url: "https://x.test" } });
    expect(screen.queryByText("Body", { selector: "label, legend" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "JSON" }));
    expect(screen.getByText("Body", { selector: "label, legend" })).toBeTruthy();
  });
});

describe("SchemaForm lists", () => {
  const listSchema: JSONSchema = {
    type: "object",
    properties: {
      tags: { type: "array", items: { type: "string" }, "x-flowline": { label: "Tags" } },
      contacts: {
        type: "array",
        "x-flowline": { label: "Contacts" },
        items: {
          type: "object",
          properties: { name: { type: "string" }, vip: { type: "boolean" } },
        },
      },
    },
  };

  test("adds, moves and removes items", () => {
    renderForm({ schema: listSchema, initial: { tags: ["a", "b"] } });
    const tags = screen.getByText("Tags").closest("fieldset") as HTMLElement;
    fireEvent.click(within(tags).getByRole("button", { name: "Move down: a" }));
    expect(latest.tags).toEqual(["b", "a"]);
    fireEvent.click(within(tags).getByRole("button", { name: "Remove: a" }));
    expect(latest.tags).toEqual(["b"]);
    fireEvent.click(within(tags).getByRole("button", { name: "Add item" }));
    expect((latest.tags as unknown[]).length).toBe(2);
  });

  test("object items render as cards with their own fields", () => {
    renderForm({ schema: listSchema, initial: { contacts: [{ name: "Ada" }] } });
    fireEvent.click(screen.getByRole("switch", { name: "Vip" }));
    expect(latest.contacts).toEqual([{ name: "Ada", vip: true }]);
  });
});
