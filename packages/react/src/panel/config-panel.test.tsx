import type { Manifest, WorkflowDoc } from "@flowkit/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import builtin from "../../playground/builtin-manifest.json";
import { editorView, typeInto } from "../../test/codemirror-dom";
import { mockClient, setupDom } from "../../test/dom";
import { docWith, fixtureDoc, manifest, step } from "../../test/fixtures";
import { FlowkitProvider } from "../provider";
import { createEditorStore, TRIGGER_KEY } from "../store/editor-store";
import { ConfigPanel } from "./config-panel";
import { sampleText } from "./trigger-config";

beforeAll(setupDom);
beforeEach(() => localStorage.clear());
afterEach(cleanup);

const core = builtin as unknown as Manifest;
const withBuiltinTriggers: Manifest = {
  plugins: [...manifest.plugins, ...core.plugins],
  nodes: manifest.nodes,
  triggers: [...manifest.triggers, ...core.triggers],
};

function setup(
  opts: {
    doc?: WorkflowDoc;
    select?: string;
    manifest?: Manifest;
    client?: ReturnType<typeof mockClient>;
    onClose?: () => void;
  } = {},
) {
  const client = opts.client ?? mockClient();
  const store = createEditorStore({
    doc: opts.doc ?? fixtureDoc(),
    manifest: opts.manifest ?? manifest,
  });
  store.getState().select(opts.select ?? "email");
  const utils = render(
    <FlowkitProvider client={client}>
      <ConfigPanel store={store} {...(opts.onClose ? { onClose: opts.onClose } : {})} />
    </FlowkitProvider>,
  );
  return { store, client, ...utils };
}

describe("ConfigPanel for a step", () => {
  test("shows the step's name, type, ID and its config form", () => {
    setup();
    expect(screen.getByRole("heading", { name: /Send email/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ID email" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Configure" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("textbox", { name: "To" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Mode" })).toBeTruthy();
  });

  test("edits write to the step's config", () => {
    const { store } = setup();
    fireEvent.click(screen.getByRole("radio", { name: "Text" }));
    const email = store.getState().doc.steps.find((s) => s.id === "email");
    expect(email?.config.mode).toBe("text");
    expect(store.getState().dirty).toBe(true);
  });

  test("renames the step in place; Esc cancels the rename without closing", () => {
    const { store } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Rename step/ }));
    const input = screen.getByRole("textbox", { name: "Rename step" });
    fireEvent.change(input, { target: { value: "Welcome email" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(store.getState().doc.steps.find((s) => s.id === "email")?.name).toBe("Welcome email");
    expect(screen.getByRole("heading", { name: /Welcome email/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Rename step/ }));
    const again = screen.getByRole("textbox", { name: "Rename step" });
    fireEvent.change(again, { target: { value: "Nope" } });
    fireEvent.keyDown(again, { key: "Escape" });
    expect(store.getState().doc.steps.find((s) => s.id === "email")?.name).toBe("Welcome email");
    expect(store.getState().selection).toBe("email");
  });

  test("Esc inside the panel closes it", () => {
    const { store } = setup();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "To" }), { key: "Escape" });
    expect(store.getState().selection).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  test("closing returns focus to the step's canvas node", async () => {
    const store = createEditorStore({ doc: fixtureDoc(), manifest });
    store.getState().select("email");
    render(
      <FlowkitProvider client={mockClient()}>
        <div className="fk-app">
          <button type="button" className="react-flow__node" data-id="step:email">
            node
          </button>
          <ConfigPanel store={store} />
        </div>
      </FlowkitProvider>,
    );
    const to = screen.getByRole("textbox", { name: "To" });
    to.focus();
    fireEvent.keyDown(to, { key: "Escape" });
    await waitFor(() => expect(document.activeElement?.getAttribute("data-id")).toBe("step:email"));
  });

  test("an Esc a control inside the panel handled itself doesn't close it", () => {
    const { store } = setup();
    const to = screen.getByRole("textbox", { name: "To" });
    to.addEventListener("keydown", (e) => e.preventDefault());
    fireEvent.keyDown(to, { key: "Escape" });
    expect(store.getState().selection).toBe("email");
  });

  test("the close button and Esc call onClose when given", () => {
    const onClose = vi.fn();
    const { store } = setup({ onClose });
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    fireEvent.keyDown(screen.getByRole("tab", { name: "Configure" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(store.getState().selection).toBe("email");
  });

  test("the Configure tab counts the step's issues; issues without a field show on top", () => {
    const doc = docWith([step("email", "crm.sendEmail", { subject: "Hi", bogus: 1 })]);
    setup({ doc });
    const tab = screen.getByRole("tab", { name: /Configure/ });
    expect(tab.textContent).toMatch(/\d/);
    // `to` is required and flagged next to its field.
    const to = screen.getByRole("textbox", { name: "To" }).closest(".fk-f") as HTMLElement;
    expect(within(to).getByText(/is required/)).toBeTruthy();
  });

  test("tabs switch with the arrow keys", () => {
    setup();
    const configure = screen.getByRole("tab", { name: "Configure" });
    fireEvent.keyDown(configure, { key: "ArrowRight" });
    const test = screen.getByRole("tab", { name: /Test/ });
    expect(test.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(test);
    expect(screen.getByRole("button", { name: "Test step" })).toBeTruthy();
  });

  test("a disabled step says so and can be enabled", () => {
    const doc = fixtureDoc();
    (doc.steps[1] as { disabled?: boolean }).disabled = true;
    const { store } = setup({ doc });
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(store.getState().doc.steps[1]?.disabled).toBeUndefined();
  });

  test("an unknown step type explains it can't be configured", () => {
    setup({ doc: docWith([step("x", "gone.node", {})]), select: "x" });
    expect(screen.getByText(/isn't available here/)).toBeTruthy();
  });
});

describe("ConfigPanel for the trigger", () => {
  test("shows the trigger type and changes it", () => {
    const { store } = setup({ select: TRIGGER_KEY, manifest: withBuiltinTriggers });
    const type = screen.getByRole("combobox", { name: "Trigger type" }) as HTMLSelectElement;
    expect(type.value).toBe("crm.contactCreated");
    fireEvent.change(type, { target: { value: "core.manual" } });
    expect(store.getState().doc.trigger.type).toBe("core.manual");
    expect(screen.getByRole("button", { name: "Add field" })).toBeTruthy();
  });

  test("the trigger's Test tab shows the store's test state, like the canvas", () => {
    const { store, container } = setup({ select: TRIGGER_KEY, manifest: withBuiltinTriggers });
    const dot = () => container.querySelector(".fk-tab__dot")?.getAttribute("data-state");
    expect(dot()).toBeUndefined();
    act(() => store.getState().setSample(TRIGGER_KEY, { contactId: "c1" }));
    expect(dot()).toBe("tested");
    act(() => store.getState().setTrigger("core.manual"));
    expect(dot()).toBe("needs-test");
  });

  test("an event trigger names its event", () => {
    setup({ select: TRIGGER_KEY });
    expect(screen.getByText(/Runs every time the contact\.created event happens/)).toBeTruthy();
  });

  test("a webhook shows 'save first' until saved, then its URL", async () => {
    const doc: WorkflowDoc = {
      ...docWith([], "leads"),
      trigger: { type: "core.webhook", config: { fields: [] } },
    };
    const saved = { ...doc, trigger: { ...doc.trigger, config: { fields: [], slug: "k3v9" } } };
    const client = mockClient({
      getWorkflow: async () => ({
        latest: {
          workflowId: "leads",
          tenantId: "acme",
          version: 2,
          doc: saved,
          createdBy: "u",
          createdAt: 0,
        },
        published: null,
      }),
    });
    Object.assign(client, { baseUrl: "/api/flowkit" });
    const { store } = setup({ doc, select: TRIGGER_KEY, manifest: withBuiltinTriggers, client });
    expect(screen.getByText("Save the workflow to generate its URL.")).toBeTruthy();

    act(() => store.getState().markSaved(2, saved));
    const url = (await screen.findByRole("textbox", { name: "Webhook URL" })) as HTMLInputElement;
    expect(url.value).toBe(`${location.origin}/api/flowkit/hooks/acme/leads/k3v9`);
    expect(screen.getByRole("button", { name: "Copy URL" })).toBeTruthy();
  });

  test("the Test tab edits the trigger's sample data", async () => {
    const doc: WorkflowDoc = {
      ...docWith([]),
      trigger: {
        type: "core.manual",
        config: { fields: [{ name: "email", type: "string", required: true }] },
      },
    };
    const { store } = setup({ doc, select: TRIGGER_KEY, manifest: withBuiltinTriggers });
    fireEvent.click(screen.getByRole("tab", { name: /Test/ }));
    const sample = screen.getByRole("textbox", { name: "Sample input" }) as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole("button", { name: "Fill from fields" }));
    expect(JSON.parse(sample.value)).toEqual({ email: "ada@example.com" });

    fireEvent.change(sample, { target: { value: "{ nope" } });
    expect(screen.getByText(/valid JSON/i)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Save sample" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.change(sample, { target: { value: '{"email":"x@y.z"}' } });
    fireEvent.click(screen.getByRole("button", { name: "Save sample" }));
    await waitFor(() => expect(store.getState().samples[TRIGGER_KEY]).toEqual({ email: "x@y.z" }));
  });

  test("Fill from fields gives each field a sample value that suits its name", () => {
    const doc: WorkflowDoc = {
      ...docWith([]),
      trigger: {
        type: "core.manual",
        config: {
          fields: [
            { name: "firstName", type: "string" },
            { name: "lastName", type: "string" },
            { name: "contactId", type: "string" },
            { name: "amount", type: "number" },
          ],
        },
      },
    };
    setup({ doc, select: TRIGGER_KEY, manifest: withBuiltinTriggers });
    fireEvent.click(screen.getByRole("tab", { name: /Test/ }));
    fireEvent.click(screen.getByRole("button", { name: "Fill from fields" }));
    const sample = screen.getByRole("textbox", { name: "Sample input" }) as HTMLTextAreaElement;
    expect(JSON.parse(sample.value)).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      contactId: "contact_123",
      amount: 1200,
    });
  });

  test("a sub-flow maps its declared outputs, with issues and undeclared keys shown", () => {
    const doc: WorkflowDoc = {
      ...fixtureDoc(),
      trigger: {
        type: "core.subflow",
        config: {
          fields: [{ name: "contactId", type: "string", required: true }],
          output: [
            { name: "email", type: "string", required: true, description: "Where to write" },
            { name: "score", type: "number" },
            { name: "vip", type: "boolean" },
            { name: "contact", type: "object" },
          ],
        },
      },
      output: { stale: "x" },
    };
    const { store } = setup({ doc, select: TRIGGER_KEY, manifest: withBuiltinTriggers });
    expect(screen.getByText("Output values")).toBeTruthy();
    expect(screen.getByText('"email" is required')).toBeTruthy();
    expect(screen.getByText(/Not a declared output field/)).toBeTruthy();
    // Each output says its declared type.
    const helps = Array.from(
      document.querySelectorAll(".fk-output .fk-f__help"),
      (p) => p.textContent,
    );
    expect(helps).toEqual(
      expect.arrayContaining(["Text · Where to write", "Number", "True / false", "Object"]),
    );

    act(() => typeInto(editorView("email"), "a@b.c"));
    expect(store.getState().doc.output).toEqual({ stale: "x", email: "a@b.c" });
    expect(screen.queryByText('"email" is required')).toBeNull();

    // Typed outputs take literals of their type (numbers, booleans), not only text.
    fireEvent.change(screen.getByRole("textbox", { name: "score" }), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("switch", { name: "vip" }));
    expect(store.getState().doc.output).toMatchObject({ score: 5, vip: true });
    expect(store.getState().issues.filter((i) => i.field?.startsWith("output."))).toEqual([]);
    // Objects take a reference (or JSON), drawn from the end-of-workflow scope.
    expect(editorView("contact")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove output stale" }));
    expect(store.getState().doc.output).not.toHaveProperty("stale");
    act(() => store.getState().undo());
    expect(store.getState().doc.output).toHaveProperty("stale", "x");
  });
});

describe("sampleText", () => {
  test("an id suffix must be its own word", () => {
    expect(sampleText("contactId")).toBe("contact_123");
    expect(sampleText("contact_id")).toBe("contact_123");
    expect(sampleText("dealID")).toBe("deal_123");
    for (const key of ["paid", "valid", "guid", "android"]) {
      expect(sampleText(key)).not.toMatch(/_123$/);
    }
  });
});
