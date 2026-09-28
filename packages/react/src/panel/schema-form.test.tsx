import {
  availableScope,
  type Issue,
  type JSONSchema,
  type Manifest,
  type ScopeEntry,
  type ValueExpr,
} from "@flowkit/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type JSX, useState } from "react";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import builtin from "../../playground/builtin-manifest.json";
import { mockClient, setupDom } from "../../test/dom";
import { fixtureDoc, manifest } from "../../test/fixtures";
import { FlowkitProvider } from "../provider";
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
    />
  );
}

function renderForm(
  props: Parameters<typeof Form>[0],
  client = mockClient({ listSecrets: async () => ["API_TOKEN", "OTHER"] }),
) {
  latest = props.initial ?? {};
  return render(
    <FlowkitProvider client={client}>
      <Form {...props} />
    </FlowkitProvider>,
  );
}

/** The field frame around a control. */
const fieldOf = (el: HTMLElement) => el.closest<HTMLElement>(".fk-f") as HTMLElement;

const mixed: JSONSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "Shown to the assignee",
      "x-flowkit": { label: "Task title" },
    },
    notify: { type: "boolean", "x-flowkit": { label: "Notify owner" } },
    retries: { type: "integer", "x-flowkit": { label: "Retries" } },
    priority: { type: "string", enum: ["low", "normal", "high"], default: "normal" },
    region: {
      type: "string",
      enum: ["emea", "amer", "apac", "latam", "anz"],
      "x-flowkit": { label: "Region" },
    },
    internal: { type: "string", "x-flowkit": { hidden: true, label: "Internal" } },
    template: { type: "string", "x-flowkit": { label: "Template", literalOnly: true } },
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

  test("the Advanced group opens by itself when it holds an issue", () => {
    renderForm({
      schema: http,
      issues: [
        { code: "config.invalid", severity: "error", message: "Too long", field: "timeoutMs" },
      ],
    });
    expect(screen.getByRole("textbox", { name: "Timeout (ms)" })).toBeTruthy();
    expect(screen.getByText("Too long")).toBeTruthy();
  });
});

describe("SchemaForm lists", () => {
  const listSchema: JSONSchema = {
    type: "object",
    properties: {
      tags: { type: "array", items: { type: "string" }, "x-flowkit": { label: "Tags" } },
      contacts: {
        type: "array",
        "x-flowkit": { label: "Contacts" },
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
