import { sectionRun, type WorkflowDoc } from "@flowlinejs/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { setupDom } from "../../test/dom";
import { docWith, manifest, step } from "../../test/fixtures";
import { defaultLabels } from "../labels";
import { layoutTree } from "../layout/layout-tree";
import { createEditorStore, type EditorStore } from "../store/editor-store";
import { rangeActions } from "./actions";
import { createCanvasUiStore } from "./canvas-context";
import { handleCanvasKey } from "./keyboard";
import { WorkflowCanvas } from "./workflow-canvas";

beforeAll(setupDom);
beforeEach(() => localStorage.clear());
afterEach(cleanup);

const L = defaultLabels;

const node = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
  if (!el) throw new Error(`no node ${id}`);
  return el;
};
const card = (id: string) => node(`step:${id}`).querySelector(".fl-card") as HTMLElement;
const inRange = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".fl-card[data-in-range]")).map(
    (el) => el.closest(".react-flow__node")?.getAttribute("data-id")?.slice(5) ?? "",
  );
const ids = (store: EditorStore) => store.getState().doc.steps.map((s) => s.id);
const bar = () => screen.getByRole("toolbar", { name: /selected$/ });
const mod = { metaKey: true, ctrlKey: true };

const email = (id: string) => step(id, "crm.sendEmail", { to: "a@b.c", subject: id });

/** load → a → b → c → cond(if: [t1, t2], else: []) → d */
function rangeDoc(sections?: WorkflowDoc["sections"]): WorkflowDoc {
  const doc = docWith([
    step("load", "crm.loadContact", { contactId: { $ref: "trigger.contactId" } }),
    email("a"),
    email("b"),
    email("c"),
    step(
      "cond",
      "logic.condition",
      { value: true },
      { branches: { if: [email("t1"), email("t2")], else: [] } },
    ),
    email("d"),
  ]);
  if (sections) doc.sections = sections;
  return doc;
}

const storeOf = (doc: WorkflowDoc, readOnly = false) =>
  createEditorStore({ doc, manifest, readOnly });

/** Whether the rendered region of section `id` contains the card of `stepId` (from the layout). */
function regionContains(store: EditorStore, sectionId: string, stepId: string): boolean {
  const { doc } = store.getState();
  const layout = layoutTree(doc, manifest);
  const r = layout.sections.find((s) => s.sectionId === sectionId);
  const c = layout.nodes.find((n) => n.id === `step:${stepId}`);
  if (!r || !c) return false;
  return c.x >= r.x && c.y >= r.y && c.x + c.w <= r.x + r.w && c.y + c.h <= r.y + r.h;
}

describe("range selection", () => {
  test("shift-click in the same list selects the run; another branch is refused", async () => {
    const store = storeOf(rangeDoc());
    render(<WorkflowCanvas store={store} />);
    fireEvent.click(node("step:a"));
    expect(store.getState().selection).toBe("a");
    fireEvent.click(node("step:c"), { shiftKey: true });
    expect(store.getState().range).toEqual({ first: "a", last: "c" });
    expect(inRange()).toEqual(["a", "b", "c"]);
    expect(bar().getAttribute("aria-label")).toBe("3 steps selected");
    expect(bar().textContent).toContain("3 steps selected");
    // The panel stays on the anchor.
    expect(store.getState().selection).toBe("a");

    fireEvent.click(node("step:t1"), { shiftKey: true });
    expect(store.getState().range).toEqual({ first: "a", last: "c" });
    expect(store.getState().selection).toBe("a");
    expect(await screen.findByText(L.rangeOtherList)).toBeTruthy();
    expect(inRange()).toEqual(["a", "b", "c"]);
  });

  test("a plain click clears the range", () => {
    const store = storeOf(rangeDoc());
    render(<WorkflowCanvas store={store} />);
    act(() => void store.getState().selectRange("a", "c"));
    expect(inRange()).toEqual(["a", "b", "c"]);
    fireEvent.click(node("step:d"));
    expect(store.getState().range).toBeNull();
    expect(inRange()).toEqual([]);
    expect(screen.queryByRole("toolbar", { name: /selected$/ })).toBeNull();
  });

  test("⇧↓ twice from a focused card selects three steps; Esc clears them", () => {
    const store = storeOf(rangeDoc());
    render(<WorkflowCanvas store={store} />);
    node("step:a").focus();
    fireEvent.keyDown(node("step:a"), { key: "ArrowDown", shiftKey: true });
    expect(document.activeElement).toBe(node("step:b"));
    fireEvent.keyDown(node("step:b"), { key: "ArrowDown", shiftKey: true });
    expect(store.getState().range).toEqual({ first: "a", last: "c" });
    expect(inRange()).toEqual(["a", "b", "c"]);
    // ⇧↑ shrinks it back from the moving end.
    fireEvent.keyDown(node("step:c"), { key: "ArrowUp", shiftKey: true });
    expect(store.getState().range).toEqual({ first: "a", last: "b" });
    // A block counts as one step of its list: ⇧↓ from c takes the condition, not its branch.
    fireEvent.keyDown(node("step:b"), { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(node("step:c"), { key: "ArrowDown", shiftKey: true });
    expect(store.getState().range).toEqual({ first: "a", last: "cond" });
    fireEvent.keyDown(node("step:cond"), { key: "Escape" });
    expect(store.getState().range).toBeNull();
    expect(inRange()).toEqual([]);
  });
});

describe("grouping", () => {
  test("⌘G on a range creates a section titled Section and sets renamingSection", () => {
    const store = storeOf(rangeDoc());
    render(<WorkflowCanvas store={store} />);
    act(() => void store.getState().selectRange("a", "c"));
    fireEvent.keyDown(node("step:a"), { key: "g", ...mod });
    const sections = store.getState().doc.sections ?? [];
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ title: "Section", color: "blue", first: "a", last: "c" });
    expect(screen.getByRole("group", { name: L.sectionRegion("Section") })).toBeTruthy();
  });

  test("group() and ⌘G on a single step set renamingSection to the new section", () => {
    const store = storeOf(rangeDoc());
    const ui = createCanvasUiStore({ overlay: undefined, labels: L });
    store.getState().selectRange("a", "b");
    rangeActions(store, ui, () => null)?.group();
    const first = store.getState().doc.sections?.[0];
    expect(first).toMatchObject({ first: "a", last: "b", title: "Section" });
    expect(ui.getState().renamingSection).toBe(first?.id);

    // ⌘G with no range groups the focused (or selected) step.
    store.getState().clearRange();
    store.getState().select("d");
    const el = document.createElement("div");
    const handled = handleCanvasKey(
      {
        key: "g",
        metaKey: true,
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        target: el,
        defaultPrevented: false,
      } as never,
      { store, ui, root: () => null, layout: () => ({ nodes: [], edges: [] }) },
    );
    expect(handled).toBe(true);
    const added = store.getState().doc.sections?.[1];
    expect(added).toMatchObject({ first: "d", last: "d" });
    expect(ui.getState().renamingSection).toBe(added?.id);
  });

  test("⌘G overlapping an existing section shows a toast and changes nothing", async () => {
    const store = storeOf(
      rangeDoc([{ id: "s", title: "Existing", color: "green", first: "b", last: "c" }]),
    );
    render(<WorkflowCanvas store={store} />);
    act(() => void store.getState().selectRange("load", "b"));
    const before = store.getState().doc;
    fireEvent.keyDown(node("step:load"), { key: "g", ...mod });
    expect(store.getState().doc).toBe(before);
    expect(await screen.findByText(/overlaps section "s"/)).toBeTruthy();
  });
});

describe("range edits", () => {
  test("Duplicate puts copies after the run, as one undo step", () => {
    const store = storeOf(rangeDoc());
    render(<WorkflowCanvas store={store} />);
    const before = store.getState().doc;
    act(() => void store.getState().selectRange("a", "b"));
    fireEvent.click(within(bar()).getByRole("button", { name: L.duplicate }));
    const steps = store.getState().doc.steps;
    expect(steps).toHaveLength(8);
    expect(steps.slice(3, 5).map((s) => s.config.subject)).toEqual(["a", "b"]);
    expect(ids(store).slice(0, 3)).toEqual(["load", "a", "b"]);
    act(() => store.getState().undo());
    expect(store.getState().doc).toEqual(before);
  });

  test("Copy + Paste pastes the whole run, as one undo step", () => {
    const store = storeOf(rangeDoc());
    render(<WorkflowCanvas store={store} />);
    act(() => void store.getState().selectRange("a", "b"));
    fireEvent.click(within(bar()).getByRole("button", { name: L.copy }));
    expect(store.getState().clipboardRun?.map((s) => s.id)).toEqual(["a", "b"]);
    fireEvent.click(node("step:d"));
    const before = store.getState().doc;
    fireEvent.keyDown(node("step:d"), { key: "v", ...mod });
    const steps = store.getState().doc.steps;
    expect(steps).toHaveLength(8);
    expect(steps.slice(6).map((s) => s.config.subject)).toEqual(["a", "b"]);
    act(() => store.getState().undo());
    expect(store.getState().doc).toEqual(before);
  });

  test("⌘C and ⌘D on a range act on the run", () => {
    const store = storeOf(rangeDoc());
    render(<WorkflowCanvas store={store} />);
    act(() => void store.getState().selectRange("a", "b"));
    fireEvent.keyDown(node("step:a"), { key: "c", ...mod });
    expect(store.getState().clipboardRun?.map((s) => s.id)).toEqual(["a", "b"]);
    fireEvent.keyDown(node("step:a"), { key: "d", ...mod });
    expect(store.getState().doc.steps).toHaveLength(8);
  });

  test("Move up and Move down move the run, each one undo step", () => {
    const store = storeOf(rangeDoc());
    render(<WorkflowCanvas store={store} />);
    act(() => void store.getState().selectRange("a", "b"));
    fireEvent.click(within(bar()).getByRole("button", { name: L.moveUp }));
    expect(ids(store)).toEqual(["a", "b", "load", "c", "cond", "d"]);
    act(() => store.getState().undo());
    expect(ids(store)).toEqual(["load", "a", "b", "c", "cond", "d"]);
    fireEvent.click(within(bar()).getByRole("button", { name: L.moveDown }));
    expect(ids(store)).toEqual(["load", "c", "a", "b", "cond", "d"]);
    // ⌥↓ from the keyboard too.
    fireEvent.keyDown(node("step:a"), { key: "ArrowDown", altKey: true });
    expect(ids(store)).toEqual(["load", "c", "cond", "a", "b", "d"]);
    act(() => store.getState().undo());
    act(() => store.getState().undo());
    expect(ids(store)).toEqual(["load", "a", "b", "c", "cond", "d"]);
    expect(store.getState().range).toEqual({ first: "a", last: "b" });
  });

  test("Delete on the toolbar removes the run with an undo toast", async () => {
    const store = storeOf(rangeDoc());
    render(<WorkflowCanvas store={store} />);
    act(() => void store.getState().selectRange("a", "c"));
    fireEvent.click(within(bar()).getByRole("button", { name: L.delete }));
    expect(ids(store)).toEqual(["load", "cond", "d"]);
    expect(store.getState().range).toBeNull();
    const toast = await screen.findByText(L.stepsDeleted(3));
    fireEvent.click(
      within(toast.parentElement as HTMLElement).getByRole("button", { name: "Undo" }),
    );
    expect(ids(store)).toEqual(["load", "a", "b", "c", "cond", "d"]);
  });

  test("Clear on the toolbar clears the range", () => {
    const store = storeOf(rangeDoc());
    render(<WorkflowCanvas store={store} />);
    act(() => void store.getState().selectRange("a", "c"));
    fireEvent.click(within(bar()).getByRole("button", { name: L.clearRange }));
    expect(store.getState().range).toBeNull();
  });

  test("right-clicking a range card shows the range items", async () => {
    const store = storeOf(rangeDoc());
    render(<WorkflowCanvas store={store} />);
    act(() => void store.getState().selectRange("a", "b"));
    fireEvent.contextMenu(card("b"));
    const menu = await screen.findByRole("menu");
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((el) => el.querySelector(".fl-menu__label")?.textContent);
    expect(items).toEqual([
      L.groupIntoSection,
      L.duplicate,
      L.copy,
      L.moveUp,
      L.moveDown,
      L.delete,
      L.clearRange,
    ]);
    fireEvent.click(within(menu).getByText(L.moveDown));
    expect(ids(store)).toEqual(["load", "c", "a", "b", "cond", "d"]);
  });

  test("right-clicking a card outside the range shows the step menu", async () => {
    const store = storeOf(rangeDoc());
    render(<WorkflowCanvas store={store} />);
    act(() => void store.getState().selectRange("a", "b"));
    fireEvent.contextMenu(card("d"));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText(L.rename)).toBeTruthy();
    expect(within(menu).queryByText(L.groupIntoSection)).toBeNull();
  });
});

describe("⌥↑/⌥↓ on a single step", () => {
  test("moves the focused step one place; nothing at an edge; focus follows", async () => {
    const store = storeOf(rangeDoc());
    render(<WorkflowCanvas store={store} />);
    node("step:b").focus();
    fireEvent.keyDown(node("step:b"), { key: "ArrowUp", altKey: true });
    expect(ids(store)).toEqual(["load", "b", "a", "c", "cond", "d"]);
    await waitFor(() => expect(document.activeElement).toBe(node("step:b")));
    const before = store.getState().doc;
    fireEvent.keyDown(node("step:load"), { key: "ArrowUp", altKey: true });
    expect(store.getState().doc).toBe(before);
    fireEvent.keyDown(node("step:t2"), { key: "ArrowDown", altKey: true });
    expect(store.getState().doc).toBe(before);
    fireEvent.keyDown(node("step:t2"), { key: "ArrowUp", altKey: true });
    const cond = store.getState().doc.steps.find((s) => s.id === "cond");
    expect(cond?.branches?.if?.map((s) => s.id)).toEqual(["t2", "t1"]);
  });

  test("⌥↑ on an interior section member keeps it in the section", () => {
    const store = storeOf(
      rangeDoc([{ id: "s", title: "Trio", color: "blue", first: "a", last: "c" }]),
    );
    render(<WorkflowCanvas store={store} />);
    fireEvent.keyDown(node("step:b"), { key: "ArrowUp", altKey: true });
    expect(ids(store)).toEqual(["load", "b", "a", "c", "cond", "d"]);
    const { doc } = store.getState();
    const s = doc.sections?.[0];
    expect(s).toBeDefined();
    expect(sectionRun(doc, s as NonNullable<typeof s>)?.ids).toContain("b");
    expect(regionContains(store, "s", "b")).toBe(true);
  });

  test("a member landing next to its section stays; moving past the far edge leaves", () => {
    const store = storeOf(
      rangeDoc([{ id: "s", title: "Duo", color: "blue", first: "a", last: "b" }]),
    );
    render(<WorkflowCanvas store={store} />);
    const run = () => {
      const { doc } = store.getState();
      const s = doc.sections?.[0];
      return s ? (sectionRun(doc, s)?.ids ?? []) : [];
    };
    fireEvent.keyDown(node("step:a"), { key: "ArrowDown", altKey: true });
    expect(ids(store)).toEqual(["load", "b", "a", "c", "cond", "d"]);
    expect(run()).toContain("a");
    expect(regionContains(store, "s", "a")).toBe(true);
    fireEvent.keyDown(node("step:a"), { key: "ArrowDown", altKey: true });
    expect(ids(store)).toEqual(["load", "b", "c", "a", "cond", "d"]);
    expect(run()).not.toContain("a");
    expect(run()).toContain("b");
    expect(regionContains(store, "s", "a")).toBe(false);
  });
});

describe("read-only", () => {
  test("range selection works, the bar shows only Copy and Clear, and remove() is a no-op", () => {
    const store = storeOf(rangeDoc(), true);
    render(<WorkflowCanvas store={store} />);
    fireEvent.click(node("step:a"));
    fireEvent.click(node("step:b"), { shiftKey: true });
    expect(store.getState().range).toEqual({ first: "a", last: "b" });
    const names = within(bar())
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual([L.copy, L.clearRange]);
    const before = store.getState().doc;
    const ui = createCanvasUiStore({ overlay: undefined, labels: L });
    const actions = rangeActions(store, ui, () => null);
    expect(actions).toBeDefined();
    actions?.remove();
    actions?.group();
    actions?.duplicate();
    actions?.moveDown();
    expect(store.getState().doc).toBe(before);
    actions?.copy();
    expect(store.getState().clipboardRun?.map((s) => s.id)).toEqual(["a", "b"]);
    // ⌘C works from the keyboard; ⌘D and ⌥↓ don't edit.
    fireEvent.keyDown(node("step:a"), { key: "d", ...mod });
    fireEvent.keyDown(node("step:a"), { key: "ArrowDown", altKey: true });
    expect(store.getState().doc).toBe(before);
    actions?.clear();
    expect(store.getState().range).toBeNull();
    expect(rangeActions(store, ui, () => null)).toBeUndefined();
  });
});

describe("labels", () => {
  test("labels={{ groupIntoSection }} overrides the toolbar's Group button", async () => {
    const { FlowlineProvider } = await import("../provider");
    const store = storeOf(rangeDoc());
    render(
      <FlowlineProvider client={{} as never} labels={{ groupIntoSection: "Grouper" }}>
        <WorkflowCanvas store={store} />
      </FlowlineProvider>,
    );
    act(() => void store.getState().selectRange("a", "b"));
    expect(within(bar()).getByRole("button", { name: "Grouper" }).textContent).toContain("Grouper");
  });
});
