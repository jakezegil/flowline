import { findStep } from "@flowlinejs/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { branchyDoc, docWith, fixtureDoc, manifest, step } from "../../test/fixtures";
import * as hooks from "../hooks";
import { defaultLabels } from "../labels";
import { createEditorStore, type EditorStore } from "../store/editor-store";
import type { RunOverlay, RunStepStatus } from "./canvas-context";
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

/** The "+" buttons on edges, named by where they insert. */
const PLUS = /^Add (first step$|step (after|to) )/;

function root(): HTMLElement {
  return document.querySelector(".fl-root") as HTMLElement;
}

/** The canvas node that has focus (`"trigger"`, `"step:<id>"`), if any. */
function focused(): string | null | undefined {
  return document.activeElement?.closest(".react-flow__node")?.getAttribute("data-id");
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
    // The whole summary is the tooltip, for when the card cuts it short (Minor 6).
    const summary = card("again").querySelector(".fl-summary");
    expect(summary?.getAttribute("title")).toBe(summary?.textContent);
  });

  test('an unset value reads "No <label>" without a pill; an all-unset summary shows the description', () => {
    const doc = docWith([step("load", "crm.loadContact", {})]);
    store = createEditorStore({ doc, manifest });
    const { unmount } = render(<WorkflowCanvas store={store} />);
    const unset = within(card("load")).getByText("No contact");
    expect(unset.classList.contains("fl-pill")).toBe(false);
    expect(unset.dataset.kind).toBe("empty");
    unmount();

    const described = {
      ...manifest,
      nodes: manifest.nodes.map((n) =>
        n.type === "crm.loadContact" ? { ...n, description: "Fetch a contact by ID" } : n,
      ),
    };
    store = createEditorStore({ doc, manifest: described });
    render(<WorkflowCanvas store={store} />);
    expect(within(card("load")).getByText("Fetch a contact by ID")).toBeTruthy();
    expect(within(card("load")).queryByText("No contact")).toBeNull();
  });

  test('clicking "+" opens the step picker and picking inserts the step there', async () => {
    render(<WorkflowCanvas store={store} />);
    const plusButtons = screen.getAllByRole("button", { name: PLUS });
    // trigger→load, load→email, email→end, each named by where it inserts (M4)
    expect(plusButtons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Add step after the trigger",
      "Add step after Load contact",
      "Add step after Send email",
    ]);
    // Out of the tab order: they'd all come before the cards.
    expect(plusButtons.map((b) => b.tabIndex)).toEqual([-1, -1, -1]);
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
    fireEvent.click(screen.getAllByRole("button", { name: PLUS })[2] as HTMLElement);
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
    const placeholders = Array.from(document.querySelectorAll<HTMLElement>(".fl-placeholder"));
    expect(placeholders.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Add step to Else of Condition",
      "Add step to Each item of For each",
    ]);
    // Placeholders stay in the tab order (they're cards of their own).
    expect(placeholders[0]?.tabIndex).toBe(0);
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
    fireEvent.contextMenu(card("email").querySelector(".fl-card") as HTMLElement);
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByText("Delete"));
    expect(findStep(store.getState().doc, "email")).toBeUndefined();
    const toast = await screen.findByText("Deleted “Send email”");
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

  test("M6: deleting another step from its menu keeps the panel's step; the store never selects a missing step", async () => {
    store = createEditorStore({ doc: branchyDoc(), manifest });
    render(<WorkflowCanvas store={store} />);
    act(() => store.getState().select("load"));
    fireEvent.contextMenu(card("each").querySelector(".fl-card") as HTMLElement);
    // L19: right-clicking moves the open panel to the menu's step.
    expect(store.getState().selection).toBe("each");
    act(() => store.getState().select("load"));
    fireEvent.keyDown(card("each"), { key: "Delete" });
    expect(findStep(store.getState().doc, "each")).toBeUndefined();
    expect(store.getState().selection).toBe("load");
    act(() => store.getState().select("each"));
    expect(store.getState().selection).toBeNull();
    // Undoing an insert removes the step the insert selected: the selection goes with it.
    const id = store.getState().insertStep({ parentId: null, index: 0 }, "crm.sendEmail");
    expect(store.getState().selection).toBe(id);
    act(() => store.getState().undo());
    expect(store.getState().selection).toBeNull();
  });

  test("M8: steps after a Stop are dimmed and say they never run", () => {
    const email = manifest.nodes.find((n) => n.type === "crm.sendEmail");
    const stop = {
      ...(email as NonNullable<typeof email>),
      type: "logic.stop",
      name: "Stop",
      endsRun: true,
      summary: undefined,
    };
    const m = { ...manifest, nodes: [...manifest.nodes, stop] };
    store = createEditorStore({
      doc: docWith([
        step("stop", "logic.stop", {}),
        step("email", "crm.sendEmail", { subject: "Hi" }),
      ]),
      manifest: m,
    });
    render(<WorkflowCanvas store={store} />);
    const after = card("email").querySelector(".fl-card") as HTMLElement;
    expect(after.hasAttribute("data-unreachable")).toBe(true);
    expect(after.textContent).toContain("Never runs: an earlier step ends the run");
    expect(card("stop").querySelector(".fl-card")?.hasAttribute("data-unreachable")).toBe(false);
    act(() => store.getState().removeStep("stop"));
    expect(card("email").querySelector(".fl-card")?.hasAttribute("data-unreachable")).toBe(false);
  });

  test("L13: an event trigger's card shows its filters by label and option label", () => {
    const [created, ...rest] = manifest.triggers;
    const trigger = {
      ...(created as NonNullable<typeof created>),
      config: {
        type: "object",
        properties: {
          stage: {
            type: "string",
            enum: ["won", "lost"],
            "x-flowline": { enumLabels: { won: "Won" } },
          },
          minAmount: { type: "number" },
          onlyChanges: { type: "boolean", "x-flowline": { label: "Only on changes" } },
          skipTests: { type: "boolean" },
          apiKey: { type: "string", "x-flowline": { secret: true } },
        },
      },
    };
    const doc = fixtureDoc();
    store = createEditorStore({
      doc: {
        ...doc,
        trigger: {
          ...doc.trigger,
          config: {
            stage: "won",
            minAmount: 5000,
            apiKey: "KEY",
            onlyChanges: true,
            skipTests: false,
          },
        },
      },
      manifest: { ...manifest, triggers: [trigger, ...rest] },
    });
    render(<WorkflowCanvas store={store} />);
    const summary = document.querySelector(
      `.react-flow__node[data-id="trigger"] .fl-card__summary`,
    );
    expect(summary?.textContent).toBe(
      "When contact.created happens · Stage: Won · Min amount: 5000 · Only on changes",
    );
  });

  test("a multi-event trigger's card caption uses labels.triggerEvents", () => {
    const [created, ...rest] = manifest.triggers;
    const twoEvents = {
      ...(created as NonNullable<typeof created>),
      event: undefined,
      events: ["ai_call.ended", "voip_call.ended"],
    };
    const doc = fixtureDoc();
    store = createEditorStore({
      doc: { ...doc, trigger: { ...doc.trigger, config: {} } },
      manifest: { ...manifest, triggers: [twoEvents, ...rest] },
    });
    render(<WorkflowCanvas store={store} />);
    const summary = document.querySelector(
      `.react-flow__node[data-id="trigger"] .fl-card__summary`,
    );
    expect(summary?.textContent).toBe(defaultLabels.triggerEvents(twoEvents.events));

    const fourEvents = { ...twoEvents, events: ["a", "b", "c", "d"] };
    store = createEditorStore({
      doc: { ...doc, trigger: { ...doc.trigger, config: {} } },
      manifest: { ...manifest, triggers: [fourEvents, ...rest] },
    });
    cleanup();
    render(<WorkflowCanvas store={store} />);
    const summary2 = document.querySelector(
      `.react-flow__node[data-id="trigger"] .fl-card__summary`,
    );
    expect(summary2?.textContent).toBe("When any of: a, b, c, +1 more");
  });

  test("a poll trigger's card caption uses labels.triggerPoll(interval)", () => {
    const [created, ...rest] = manifest.triggers;
    const poll = {
      ...(created as NonNullable<typeof created>),
      type: "crm.dealStuckInStage",
      kind: "poll" as const,
      event: undefined,
      interval: 300_000,
    };
    const doc = fixtureDoc();
    store = createEditorStore({
      doc: { ...doc, trigger: { ...doc.trigger, type: "crm.dealStuckInStage", config: {} } },
      manifest: { ...manifest, triggers: [poll, ...rest] },
    });
    render(<WorkflowCanvas store={store} />);
    const summary = document.querySelector(
      `.react-flow__node[data-id="trigger"] .fl-card__summary`,
    );
    expect(summary?.textContent).toBe(defaultLabels.triggerPoll(300_000));
    expect(summary?.textContent).toBe("Checks every 5 minutes");
  });

  test("L19: right-click with no panel open doesn't open one", () => {
    render(<WorkflowCanvas store={store} />);
    fireEvent.contextMenu(card("email").querySelector(".fl-card") as HTMLElement);
    expect(store.getState().selection).toBeNull();
  });

  test("M4: keys act on the focused card: Enter or Space opens it, arrows go on from it, ⌘D duplicates it with the panel closed", () => {
    const onStepClick = vi.fn();
    render(<WorkflowCanvas store={store} onStepClick={onStepClick} />);
    const ids = () => store.getState().doc.steps.map((s) => s.id);
    fireEvent.keyDown(card("email"), { key: "d", ctrlKey: true });
    expect(ids()).toEqual(["load", "email", "sendEmail"]);
    expect(store.getState().selection).toBeNull();
    fireEvent.keyDown(card("load"), { key: "ArrowDown" });
    // Minor 8: arrows move focus, not the selection (no panel opens on the way).
    expect(focused()).toBe("step:email");
    expect(store.getState().selection).toBeNull();
    fireEvent.keyDown(card("load"), { key: " " });
    expect(store.getState().selection).toBe("load");
    expect(onStepClick).toHaveBeenLastCalledWith("load");
    act(() => store.getState().select(null));
    fireEvent.keyDown(card("email"), { key: "Enter" });
    expect(store.getState().selection).toBe("email");
  });

  test("M4: ⇧⌘K adds a step before the focused card", async () => {
    store = createEditorStore({ doc: branchyDoc(), manifest });
    render(<WorkflowCanvas store={store} />);
    fireEvent.keyDown(card("email"), { key: "k", ctrlKey: true, shiftKey: true });
    fireEvent.click(within(await screen.findByRole("dialog")).getByText("Switch"));
    const cond = findStep(store.getState().doc, "cond")?.step;
    expect(cond?.branches?.if?.map((s) => s.type)).toEqual(["logic.switch", "crm.sendEmail"]);
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
    fireEvent.contextMenu(card("load").querySelector(".fl-card") as HTMLElement);
    fireEvent.click(within(await screen.findByRole("menu")).getByText("Copy reference"));
    expect(writeText).toHaveBeenCalledWith("{{steps.load}}");
    expect(await screen.findByText("Reference copied")).toBeTruthy();
  });

  test("Replace… opens the picker in replace mode and keeps the step's ID", async () => {
    render(<WorkflowCanvas store={store} />);
    fireEvent.contextMenu(card("email").querySelector(".fl-card") as HTMLElement);
    fireEvent.click(within(await screen.findByRole("menu")).getByText("Replace…"));
    const picker = await screen.findByRole("dialog", { name: "Replace step" });
    // L29: the search box is named for what it does, not after the dialog.
    expect(within(picker).getByRole("combobox", { name: "Search steps" })).toBeTruthy();
    // The current type isn't offered.
    expect(within(picker).queryByText("Send email")).toBeNull();
    fireEvent.click(within(picker).getByText("Load contact"));
    expect(findStep(store.getState().doc, "email")?.step.type).toBe("crm.loadContact");
  });

  test("ArrowDown/ArrowUp move focus in tree order; ←/→ switch branch columns; Enter opens", () => {
    const doc = branchyDoc();
    (doc.steps[1] as (typeof doc.steps)[number]).branches = {
      if: [step("email", "crm.sendEmail", { to: "a", subject: "b" })],
      else: [step("other", "crm.sendEmail", { to: "a", subject: "b" })],
    };
    store = createEditorStore({ doc, manifest });
    render(<WorkflowCanvas store={store} />);
    const key = (k: string) => fireEvent.keyDown(root(), { key: k });
    key("ArrowDown");
    expect(focused()).toBe("trigger");
    key("ArrowDown");
    expect(focused()).toBe("step:load");
    key("ArrowDown");
    key("ArrowDown");
    expect(focused()).toBe("step:email");
    key("ArrowRight");
    expect(focused()).toBe("step:other");
    key("ArrowRight");
    expect(focused()).toBe("step:other");
    key("ArrowLeft");
    expect(focused()).toBe("step:email");
    key("ArrowUp");
    expect(focused()).toBe("step:cond");
    expect(store.getState().selection).toBeNull();
    key("Enter");
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

  test('Enter on a focused "+" opens the picker instead of opening the selection', async () => {
    const user = userEvent.setup();
    const onStepClick = vi.fn();
    render(<WorkflowCanvas store={store} onStepClick={onStepClick} />);
    act(() => store.getState().select("load"));
    (screen.getAllByRole("button", { name: PLUS })[1] as HTMLElement).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Add step" })).toBeTruthy();
    expect(onStepClick).not.toHaveBeenCalled();
  });

  test("Backspace on the toast's Undo button doesn't delete the selected step", async () => {
    const user = userEvent.setup();
    render(<WorkflowCanvas store={store} />);
    act(() => store.getState().select("email"));
    fireEvent.keyDown(root(), { key: "Delete" });
    expect(store.getState().selection).toBe("load");
    const toast = await screen.findByText("Deleted “Send email”");
    // Focus moves to the neighbour on the next frame; wait so it doesn't steal focus back.
    await waitFor(() => expect(document.activeElement).toBe(card("load")));
    within(toast.parentElement as HTMLElement)
      .getByRole("button", { name: "Undo" })
      .focus();
    await user.keyboard("{Backspace}");
    expect(findStep(store.getState().doc, "load")).toBeDefined();
    await user.keyboard("{Enter}");
    expect(findStep(store.getState().doc, "email")).toBeDefined();
  });

  test.each([
    ["Enter", "{Enter}"],
    ["Escape", "{Escape}"],
  ])("arrow keys work after ending a rename with %s", async (_, finish) => {
    const user = userEvent.setup();
    render(<WorkflowCanvas store={store} />);
    act(() => store.getState().select("load"));
    fireEvent.keyDown(root(), { key: "F2" });
    const input = await screen.findByRole("textbox", { name: "Step name" });
    await user.type(input, "x");
    await user.keyboard(finish);
    await waitFor(() => expect(document.activeElement).toBe(card("load")));
    await user.keyboard("{ArrowDown}");
    expect(focused()).toBe("step:email");
  });

  test('Esc in the picker returns focus to its "+", and arrow keys still work', async () => {
    const user = userEvent.setup();
    render(<WorkflowCanvas store={store} />);
    act(() => store.getState().select("load"));
    const plus = screen.getAllByRole("button", { name: PLUS })[1] as HTMLElement;
    await user.click(plus);
    await screen.findByRole("dialog", { name: "Add step" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(plus));
    await user.keyboard("{ArrowDown}");
    expect(focused()).toBe("step:email");
  });

  test("L20: Esc after ⌘K returns focus to the card it was pressed on", async () => {
    const user = userEvent.setup();
    render(<WorkflowCanvas store={store} />);
    card("email").focus();
    fireEvent.keyDown(card("email"), { key: "k", ctrlKey: true });
    await screen.findByRole("dialog", { name: "Add step" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(card("email")));
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
    expect(screen.queryAllByRole("button", { name: PLUS })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: "Add step" })).toHaveLength(0);
    expect(screen.getAllByText("No steps")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /^Actions for/ })).toBeNull();
    act(() => store.getState().select("load"));
    fireEvent.keyDown(root(), { key: "Delete" });
    fireEvent.keyDown(root(), { key: "d", ctrlKey: true });
    expect(store.getState().doc.steps).toHaveLength(3);
    // Navigation still works.
    fireEvent.keyDown(root(), { key: "ArrowDown" });
    expect(focused()).toBe("step:cond");
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
    expect(card("email").querySelector(".fl-card")?.hasAttribute("data-disabled")).toBe(true);
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

  test("the loop iteration stepper shows only for loops that ran, red only when failed", () => {
    store = createEditorStore({ doc: branchyDoc(), manifest });
    const overlay = (status: RunStepStatus["status"]): RunOverlay => ({
      stepStatus: { each: { status } },
      takenEdges: new Set(),
      loopIteration: { each: { index: 1, count: 3, failedIndex: 1 } },
    });
    const counter = () => within(card("each")).queryByText("2 / 3");
    const { rerender } = render(
      <WorkflowCanvas store={store} readOnly overlay={overlay("pending")} />,
    );
    expect(counter()).toBeNull();
    rerender(<WorkflowCanvas store={store} readOnly overlay={overlay("skipped")} />);
    expect(counter()).toBeNull();
    rerender(<WorkflowCanvas store={store} readOnly overlay={overlay("done")} />);
    expect(counter()?.dataset.failed).toBeUndefined();
    rerender(<WorkflowCanvas store={store} readOnly overlay={overlay("failed")} />);
    expect(counter()?.dataset.failed).toBeDefined();
  });

  test("applies the color mode and token overrides to the root", async () => {
    const { FlowlineProvider } = await import("../provider");
    render(
      <FlowlineProvider
        client={{} as never}
        theme={{ colorMode: "dark", tokens: { accent: "#0f766e", radius: "4px" } }}
      >
        <WorkflowCanvas store={store} />
      </FlowlineProvider>,
    );
    expect(root().dataset.flTheme).toBe("dark");
    expect(root().style.getPropertyValue("--fl-accent")).toBe("#0f766e");
    expect(root().style.getPropertyValue("--fl-radius")).toBe("4px");
  });

  test("labels on the provider replace the UI text; unset labels stay English", async () => {
    const { FlowlineProvider } = await import("../provider");
    render(
      <FlowlineProvider
        client={{} as never}
        labels={{
          addStepAfter: (s: string) => `Schritt nach ${s} einfügen`,
          addStepAfterTrigger: () => "Schritt hier einfügen",
          addStep: "Schritt hinzufügen",
          tabAll: "Alle",
          triggerTag: "Auslöser",
        }}
      >
        <WorkflowCanvas store={store} />
      </FlowlineProvider>,
    );
    expect(screen.getByText("Auslöser")).toBeTruthy();
    const plus = screen.getAllByRole("button", { name: /^Schritt (hier|nach)/ });
    expect(plus).toHaveLength(3);
    fireEvent.click(plus[0] as HTMLElement);
    const picker = await screen.findByRole("dialog", { name: "Schritt hinzufügen" });
    expect(within(picker).getByRole("tab", { name: "Alle" })).toBeTruthy();
    expect(within(picker).getByRole("tab", { name: "Logic" })).toBeTruthy();
  });

  test("picker tabs use a roving tabindex and control the list's tabpanel", async () => {
    render(<WorkflowCanvas store={store} />);
    fireEvent.click(screen.getAllByRole("button", { name: PLUS })[0] as HTMLElement);
    const picker = await screen.findByRole("dialog", { name: "Add step" });
    const [all, second] = within(picker).getAllByRole("tab") as [HTMLElement, HTMLElement];
    expect(all.textContent).toBe("All");
    const panel = within(picker).getByRole("tabpanel");
    expect(all.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(all.id);
    expect([all.tabIndex, second.tabIndex]).toEqual([0, -1]);
    all.focus();
    fireEvent.keyDown(all, { key: "ArrowRight" });
    expect(document.activeElement).toBe(second);
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect([all.tabIndex, second.tabIndex]).toEqual([-1, 0]);
    expect(panel.getAttribute("aria-labelledby")).toBe(second.id);
    fireEvent.keyDown(second, { key: "Home" });
    expect(document.activeElement).toBe(all);
  });

  test("host icons override bundled ones by name; unknown names fall back", async () => {
    const { FlowlineProvider } = await import("../provider");
    const { resolveIconIn } = await import("../icons");
    const Custom = () => <svg data-testid="custom-user" />;
    render(
      <FlowlineProvider client={{} as never} icons={{ user: Custom }}>
        <WorkflowCanvas store={store} />
      </FlowlineProvider>,
    );
    expect(within(card("load")).getByTestId("custom-user")).toBeTruthy();
    expect(resolveIconIn(undefined, "no-such-icon")).toBe(resolveIconIn(undefined, undefined));
    expect(resolveIconIn(undefined, "GitFork")).toBe(resolveIconIn(undefined, "git-fork"));
  });
});

describe("S15: Backspace/Delete on the card's “…” and on “+” delete the selected step", () => {
  test("Backspace on the selected card's “…” trigger deletes it", async () => {
    const user = userEvent.setup();
    render(<WorkflowCanvas store={store} />);
    act(() => store.getState().select("email"));
    within(card("email"))
      .getByRole("button", { name: /^Actions for / })
      .focus();
    await user.keyboard("{Backspace}");
    expect(findStep(store.getState().doc, "email")).toBeUndefined();
    expect(await screen.findByText("Deleted “Send email”")).toBeTruthy();
  });

  test("Backspace (and Delete) on a “+” deletes the selected step", async () => {
    const user = userEvent.setup();
    render(<WorkflowCanvas store={store} />);
    act(() => store.getState().select("email"));
    (screen.getAllByRole("button", { name: PLUS })[0] as HTMLElement).focus();
    await user.keyboard("{Backspace}");
    expect(findStep(store.getState().doc, "email")).toBeUndefined();
    // Focus goes to the neighbour on the next frame; wait so it doesn't steal focus back.
    await waitFor(() => expect(document.activeElement).toBe(card("load")));
    const plus = screen.getAllByRole("button", { name: PLUS })[0] as HTMLElement;
    plus.focus();
    expect(document.activeElement).toBe(plus);
    await user.keyboard("{Delete}");
    expect(store.getState().doc.steps).toEqual([]);
  });

  test("Enter on “+” still opens the picker; back on it, Backspace deletes", async () => {
    const user = userEvent.setup();
    render(<WorkflowCanvas store={store} />);
    act(() => store.getState().select("email"));
    const plus = screen.getAllByRole("button", { name: PLUS })[1] as HTMLElement;
    plus.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Add step" })).toBeTruthy();
    expect(findStep(store.getState().doc, "email")).toBeDefined();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(plus));
    await user.keyboard("{Backspace}");
    expect(findStep(store.getState().doc, "email")).toBeUndefined();
  });
});
