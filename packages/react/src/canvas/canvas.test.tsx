import { findStep } from "@flowkit/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { branchyDoc, docWith, fixtureDoc, manifest, step } from "../../test/fixtures";
import * as hooks from "../hooks";
import { createEditorStore, type EditorStore, TRIGGER_KEY } from "../store/editor-store";
import type { RunOverlay } from "./canvas-context";
import { WorkflowCanvas } from "./workflow-canvas";

vi.mock("../hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks")>();
  return { ...actual, useStep: vi.fn(actual.useStep) };
});

beforeAll(() => {
  // jsdom has no layout: give xyflow a sized container and the APIs Radix/cmdk expect.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 1200 },
    offsetHeight: { configurable: true, get: () => 800 },
  });
  Element.prototype.scrollIntoView = () => {};
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

let store: EditorStore;

beforeEach(() => {
  localStorage.clear();
  store = createEditorStore({ doc: fixtureDoc(), manifest });
});
afterEach(() => {
  cleanup();
  vi.mocked(hooks.useStep).mockClear();
});

/** The card element of a step. */
function card(stepId: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`.react-flow__node[data-id="step:${stepId}"]`);
  if (!node) throw new Error(`no card for ${stepId}`);
  return node;
}

function root(): HTMLElement {
  return document.querySelector(".fk-root") as HTMLElement;
}

describe("WorkflowCanvas", () => {
  test("renders a card per step with its name and rendered summary", () => {
    render(<WorkflowCanvas store={store} />);
    const load = within(card("load"));
    expect(load.getByText("Load contact")).toBeTruthy();
    // summary "Load {{contactId}}" with contactId = { $ref: "trigger.contactId" }
    expect(load.getByText("Load")).toBeTruthy();
    expect(load.getByText("Trigger › contactId")).toBeTruthy();
    expect(within(card("email")).getByText("Send email")).toBeTruthy();
    expect(screen.getByText("Contact created")).toBeTruthy();
  });

  test("a literal summary value renders as text, a step ref by the step's name", () => {
    store = createEditorStore({
      doc: docWith([
        step("load", "crm.loadContact", { contactId: "c_42" }),
        step("again", "crm.loadContact", { contactId: { $ref: "steps.load.id" } }),
      ]),
      manifest,
    });
    render(<WorkflowCanvas store={store} />);
    expect(within(card("load")).getByText("Load c_42")).toBeTruthy();
    expect(within(card("again")).getByText("Load contact › id")).toBeTruthy();
  });

  test('clicking "+" opens the step picker and picking inserts the step there', async () => {
    render(<WorkflowCanvas store={store} />);
    const plusButtons = screen.getAllByRole("button", { name: "Add step here" });
    // trigger→load, load→email, email→end
    expect(plusButtons).toHaveLength(3);
    fireEvent.click(plusButtons[1] as HTMLElement);
    const picker = await screen.findByRole("dialog", { name: "Add step" });
    expect(within(picker).getByRole("tab", { name: "All" })).toBeTruthy();
    expect(within(picker).getByRole("tab", { name: "Logic" })).toBeTruthy();
    fireEvent.click(within(picker).getByText("Condition"));
    const steps = store.getState().doc.steps;
    expect(steps.map((s) => s.type)).toEqual([
      "crm.loadContact",
      "logic.condition",
      "crm.sendEmail",
    ]);
    expect(store.getState().selection).toBe(steps[1]?.id);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("the picker filters by search and Enter inserts the highlighted step", async () => {
    render(<WorkflowCanvas store={store} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Add step here" })[2] as HTMLElement);
    const picker = await screen.findByRole("dialog", { name: "Add step" });
    const input = within(picker).getByRole("combobox");
    fireEvent.change(input, { target: { value: "each" } });
    await waitFor(() => expect(within(picker).queryByText("Send email")).toBeNull());
    fireEvent.keyDown(input, { key: "Enter" });
    expect(store.getState().doc.steps.at(-1)?.type).toBe("logic.forEach");
  });

  test("an empty branch shows an Add step placeholder that inserts into it", async () => {
    store = createEditorStore({ doc: branchyDoc(), manifest });
    render(<WorkflowCanvas store={store} />);
    const placeholders = screen.getAllByRole("button", { name: "Add step" });
    expect(placeholders).toHaveLength(2); // cond.else, each.body
    fireEvent.click(placeholders[0] as HTMLElement);
    fireEvent.click(within(await screen.findByRole("dialog")).getByText("Send email"));
    const cond = findStep(store.getState().doc, "cond")?.step;
    expect(cond?.branches?.else?.map((s) => s.type)).toEqual(["crm.sendEmail"]);
  });

  test("branch edges are labelled; leftover branches get a warning label", () => {
    const doc = branchyDoc();
    const cond = doc.steps[1] as (typeof doc.steps)[number];
    cond.branches = {
      ...cond.branches,
      legacy: [step("old", "crm.sendEmail", { to: "a", subject: "b" })],
    };
    store = createEditorStore({ doc, manifest });
    render(<WorkflowCanvas store={store} />);
    expect(screen.getByText("If")).toBeTruthy();
    expect(screen.getByText("Else")).toBeTruthy();
    expect(screen.getByText("Each item")).toBeTruthy();
    const leftover = screen.getByText("Leftover: legacy").parentElement as HTMLElement;
    expect(leftover.dataset.leftover).toBeDefined();
    expect(leftover.title).toMatch(/isn't part of this step's type/);
  });

  test("context menu Delete removes the step, and the toast's Undo restores it", async () => {
    render(<WorkflowCanvas store={store} />);
    fireEvent.contextMenu(card("email").querySelector(".fk-card") as HTMLElement);
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByText("Delete"));
    expect(findStep(store.getState().doc, "email")).toBeUndefined();
    const toast = await screen.findByText("Step deleted");
    fireEvent.click(
      within(toast.parentElement as HTMLElement).getByRole("button", { name: "Undo" }),
    );
    expect(findStep(store.getState().doc, "email")).toBeDefined();
  });

  test("deleting moves selection to the next step, else the previous, else the owner", () => {
    store = createEditorStore({ doc: branchyDoc(), manifest });
    render(<WorkflowCanvas store={store} />);
    act(() => store.getState().select("load"));
    fireEvent.keyDown(root(), { key: "Delete" });
    expect(store.getState().selection).toBe("cond");
    act(() => store.getState().select("email"));
    fireEvent.keyDown(root(), { key: "Delete" });
    // "email" was alone in cond.if
    expect(store.getState().selection).toBe("cond");
    act(() => store.getState().select("each"));
    fireEvent.keyDown(root(), { key: "Delete" });
    expect(store.getState().selection).toBe("cond");
  });

  test("the kebab menu offers the same actions, including tree-aware paste", async () => {
    store = createEditorStore({ doc: branchyDoc(), manifest });
    render(<WorkflowCanvas store={store} />);
    act(() => store.getState().copy("load"));
    fireEvent.pointerDown(
      within(card("cond")).getByRole("button", { name: "Actions for Condition" }),
      {
        button: 0,
        pointerType: "mouse",
      },
    );
    const menu = await screen.findByRole("menu");
    for (const label of [
      "Rename",
      "Duplicate",
      "Copy reference",
      "Replace…",
      "Disable",
      "Copy",
      "Paste after",
      "Paste inside branch",
      "Delete",
    ]) {
      expect(within(menu).getByText(label)).toBeTruthy();
    }
    expect(within(menu).queryByText("Paste inside loop")).toBeNull();
    fireEvent.click(within(menu).getByText("Disable"));
    expect(findStep(store.getState().doc, "cond")?.step.disabled).toBe(true);
  });

  test("Copy reference writes {{steps.<id>}} to the clipboard", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<WorkflowCanvas store={store} />);
    fireEvent.contextMenu(card("load").querySelector(".fk-card") as HTMLElement);
    fireEvent.click(within(await screen.findByRole("menu")).getByText("Copy reference"));
    expect(writeText).toHaveBeenCalledWith("{{steps.load}}");
    expect(await screen.findByText("Reference copied")).toBeTruthy();
  });

  test("Replace… opens the picker in replace mode and keeps the step's ID", async () => {
    render(<WorkflowCanvas store={store} />);
    fireEvent.contextMenu(card("email").querySelector(".fk-card") as HTMLElement);
    fireEvent.click(within(await screen.findByRole("menu")).getByText("Replace…"));
    const picker = await screen.findByRole("dialog", { name: "Replace step" });
    // The current type isn't offered.
    expect(within(picker).queryByText("Send email")).toBeNull();
    fireEvent.click(within(picker).getByText("Load contact"));
    expect(findStep(store.getState().doc, "email")?.step.type).toBe("crm.loadContact");
  });

  test("ArrowDown/ArrowUp move the selection in tree order; ←/→ switch branch columns", () => {
    const doc = branchyDoc();
    (doc.steps[1] as (typeof doc.steps)[number]).branches = {
      if: [step("email", "crm.sendEmail", { to: "a", subject: "b" })],
      else: [step("other", "crm.sendEmail", { to: "a", subject: "b" })],
    };
    store = createEditorStore({ doc, manifest });
    render(<WorkflowCanvas store={store} />);
    const key = (k: string) => fireEvent.keyDown(root(), { key: k });
    key("ArrowDown");
    expect(store.getState().selection).toBe(TRIGGER_KEY);
    key("ArrowDown");
    expect(store.getState().selection).toBe("load");
    key("ArrowDown");
    key("ArrowDown");
    expect(store.getState().selection).toBe("email");
    key("ArrowRight");
    expect(store.getState().selection).toBe("other");
    key("ArrowRight");
    expect(store.getState().selection).toBe("other");
    key("ArrowLeft");
    expect(store.getState().selection).toBe("email");
    key("ArrowUp");
    expect(store.getState().selection).toBe("cond");
    key("Escape");
    expect(store.getState().selection).toBeNull();
  });

  test("shortcuts: Delete, undo/redo, duplicate, copy/paste; ignored while typing", () => {
    render(<WorkflowCanvas store={store} />);
    const ids = () => store.getState().doc.steps.map((s) => s.id);
    act(() => store.getState().select("email"));
    fireEvent.keyDown(root(), { key: "d", ctrlKey: true });
    expect(ids()).toEqual(["load", "email", "sendEmail"]);
    fireEvent.keyDown(root(), { key: "z", ctrlKey: true });
    expect(ids()).toEqual(["load", "email"]);
    fireEvent.keyDown(root(), { key: "z", ctrlKey: true, shiftKey: true });
    expect(ids()).toEqual(["load", "email", "sendEmail"]);
    act(() => store.getState().select("load"));
    fireEvent.keyDown(root(), { key: "c", ctrlKey: true });
    fireEvent.keyDown(root(), { key: "v", ctrlKey: true });
    expect(ids()).toEqual(["load", "loadContact", "email", "sendEmail"]);
    act(() => store.getState().select("email"));
    fireEvent.keyDown(root(), { key: "Delete" });
    expect(ids()).toEqual(["load", "loadContact", "sendEmail"]);

    const input = document.createElement("input");
    root().appendChild(input);
    act(() => store.getState().select("load"));
    fireEvent.keyDown(input, { key: "Backspace" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(ids()).toEqual(["load", "loadContact", "sendEmail"]);
    expect(store.getState().selection).toBe("load");
  });

  test("⌘K opens the picker to insert after the selected step", async () => {
    render(<WorkflowCanvas store={store} />);
    act(() => store.getState().select("load"));
    fireEvent.keyDown(root(), { key: "k", ctrlKey: true });
    fireEvent.click(within(await screen.findByRole("dialog")).getByText("Switch"));
    expect(store.getState().doc.steps.map((s) => s.type)).toEqual([
      "crm.loadContact",
      "logic.switch",
      "crm.sendEmail",
    ]);
  });

  test("readOnly hides add buttons, placeholders' actions and menus, and blocks edits", () => {
    store = createEditorStore({ doc: branchyDoc(), manifest });
    render(<WorkflowCanvas store={store} readOnly />);
    expect(screen.queryAllByRole("button", { name: "Add step here" })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: "Add step" })).toHaveLength(0);
    expect(screen.getAllByText("No steps")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /^Actions for/ })).toBeNull();
    act(() => store.getState().select("load"));
    fireEvent.keyDown(root(), { key: "Delete" });
    fireEvent.keyDown(root(), { key: "d", ctrlKey: true });
    expect(store.getState().doc.steps).toHaveLength(3);
    // Navigation still works.
    fireEvent.keyDown(root(), { key: "ArrowDown" });
    expect(store.getState().selection).toBe("cond");
  });

  test("an invalid step shows a badge whose label lists its issues", () => {
    render(<WorkflowCanvas store={store} />);
    act(() => store.getState().setConfig("email", "to", undefined));
    const badge = within(card("email")).getByRole("img", { name: /issue/ });
    expect(badge.getAttribute("aria-label")).toBe('1 issue: "To" is required');
    expect(badge.dataset.tone).toBe("danger");
    expect(within(card("load")).queryByRole("img", { name: /issue/ })).toBeNull();
  });

  test("tested, needs-test and disabled states are shown on the card", () => {
    render(<WorkflowCanvas store={store} />);
    act(() => store.getState().setSample("load", { id: "c1" }));
    expect(within(card("load")).getByRole("img", { name: "Tested" })).toBeTruthy();
    act(() => store.getState().setConfig("load", "contactId", "c2"));
    expect(within(card("load")).getByRole("img", { name: "Edited since last test" })).toBeTruthy();
    act(() => store.getState().toggleDisabled("email"));
    expect(within(card("email")).getByText("Disabled")).toBeTruthy();
    expect(card("email").querySelector(".fk-card")?.hasAttribute("data-disabled")).toBe(true);
  });

  test("F2 renames inline; Enter saves", () => {
    render(<WorkflowCanvas store={store} />);
    act(() => store.getState().select("email"));
    fireEvent.keyDown(root(), { key: "F2" });
    const input = within(card("email")).getByRole("textbox", { name: "Step name" });
    fireEvent.change(input, { target: { value: "Welcome email" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(findStep(store.getState().doc, "email")?.step.name).toBe("Welcome email");
    expect(within(card("email")).getByText("Welcome email")).toBeTruthy();
  });

  test("editing one step doesn't re-render the other cards", () => {
    store = createEditorStore({ doc: branchyDoc(), manifest });
    render(<WorkflowCanvas store={store} />);
    const useStep = vi.mocked(hooks.useStep);
    const renders = (id: string) => useStep.mock.calls.filter(([s]) => s === id).length;
    const before = { email: renders("email"), load: renders("load"), each: renders("each") };
    // email sits inside cond's "if" branch; "each" is a sibling branching step.
    act(() => store.getState().setConfig("email", "subject", "Changed"));
    expect(renders("email")).toBeGreaterThan(before.email);
    expect(renders("load")).toBe(before.load);
    expect(renders("each")).toBe(before.each);
  });

  test("run overlay shows statuses, durations and dims untaken branches", () => {
    store = createEditorStore({ doc: branchyDoc(), manifest });
    const overlay: RunOverlay = {
      stepStatus: {
        load: { status: "done", durationMs: 1250 },
        cond: { status: "done", durationMs: 3 },
        email: { status: "failed", durationMs: 800, attempts: 3 },
      },
      takenEdges: new Set(["step:cond->step:email"]),
      loopIteration: {},
    };
    render(<WorkflowCanvas store={store} readOnly overlay={overlay} />);
    expect(within(card("load")).getByText("Succeeded · 1.3s")).toBeTruthy();
    expect(within(card("email")).getByText("Failed · 800ms · 3 attempts")).toBeTruthy();
    expect(within(card("email")).getByRole("img", { name: "Failed" })).toBeTruthy();
    expect(screen.getByText("Else").parentElement?.dataset.dimmed).toBeDefined();
    expect(screen.getByText("If").parentElement?.dataset.dimmed).toBeUndefined();
  });

  test("applies the color mode and token overrides to the root", async () => {
    const { FlowkitProvider } = await import("../provider");
    render(
      <FlowkitProvider
        client={{} as never}
        theme={{ colorMode: "dark", tokens: { accent: "#0f766e", radius: "4px" } }}
      >
        <WorkflowCanvas store={store} />
      </FlowkitProvider>,
    );
    expect(root().dataset.fkTheme).toBe("dark");
    expect(root().style.getPropertyValue("--fk-accent")).toBe("#0f766e");
    expect(root().style.getPropertyValue("--fk-radius")).toBe("4px");
  });
});
