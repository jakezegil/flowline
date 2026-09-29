import {
  type AnnotationColor,
  type ApplyError,
  FlowlineCommandError,
  findStep,
  type Section,
  type Step,
  type WorkflowDoc,
} from "@flowlinejs/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { mockClient, setupDom } from "../../test/dom";
import { docWith, manifest, step } from "../../test/fixtures";
import { defaultLabels as L } from "../labels";
import { FlowlineProvider } from "../provider";
import { createEditorStore, type EditorStore } from "../store/editor-store";
import { WorkflowCanvas } from "./workflow-canvas";

beforeAll(setupDom);
beforeEach(() => localStorage.clear());
afterEach(cleanup);

const node = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
  if (!el) throw new Error(`no node ${id}`);
  return el;
};
const cardOf = (id: string) => node(`step:${id}`).querySelector(".fl-card") as HTMLElement;
const mod = { metaKey: true, ctrlKey: true };
const email = (id: string, extra: Partial<Step> = {}) =>
  step(id, "crm.sendEmail", { to: "a@b.c", subject: id }, extra);

/** load → a → b → c, with the optional sections. */
function docOf(opts: { sections?: Section[]; a?: Partial<Step> } = {}): WorkflowDoc {
  const doc = docWith([
    step("load", "crm.loadContact", { contactId: { $ref: "trigger.contactId" } }),
    email("a", opts.a),
    email("b"),
    email("c"),
  ]);
  if (opts.sections) doc.sections = opts.sections;
  return doc;
}

const intro = (extra: Partial<Section> = {}): Section => ({
  id: "intro",
  title: "Welcome",
  color: "blue",
  first: "a",
  last: "b",
  ...extra,
});

const storeOf = (doc: WorkflowDoc, readOnly = false): EditorStore =>
  createEditorStore({ doc, manifest, readOnly });

const stepOf = (store: EditorStore, id: string) => findStep(store.getState().doc, id)?.step;
const codes = (store: EditorStore) => store.getState().issues.map((i) => i.code);

/** Opens a card's right-click menu and returns it. */
async function stepMenu(id: string): Promise<HTMLElement> {
  fireEvent.contextMenu(cardOf(id));
  return screen.findByRole("menu");
}

/** Opens the header chip's menu of section `id` and returns it. */
async function chipMenu(id: string): Promise<HTMLElement> {
  const chip = within(node(`sectionHeader:${id}`)).getByRole("button");
  fireEvent.pointerDown(chip, { button: 0, pointerType: "mouse" });
  return screen.findByRole("menu");
}

/** Opens the Color submenu of an open menu and returns it. */
async function colorSubmenu(menu: HTMLElement): Promise<HTMLElement> {
  fireEvent.click(within(menu).getByText(L.color));
  await waitFor(() => expect(screen.getAllByRole("menu").length).toBeGreaterThan(1));
  return screen.getAllByRole("menu").at(-1) as HTMLElement;
}

describe("step menus", () => {
  test("Color sets the step's colour; No color removes it", async () => {
    const store = storeOf(docOf());
    render(<WorkflowCanvas store={store} />);
    let sub = await colorSubmenu(await stepMenu("a"));
    // Each colour is a swatch plus its name, then No color.
    for (const c of ["yellow", "blue", "green", "pink", "purple", "gray"] as AnnotationColor[]) {
      const item = within(sub).getByText(L.colorNames[c]).closest("[role=menuitem]");
      expect(item?.querySelector(`.fl-menu__swatch[data-color="${c}"]`)).toBeTruthy();
    }
    fireEvent.click(within(sub).getByText(L.colorNames.pink));
    expect(stepOf(store, "a")?.color).toBe("pink");
    expect(cardOf("a").dataset.color).toBe("pink");

    sub = await colorSubmenu(await stepMenu("a"));
    fireEvent.click(within(sub).getByText(L.noColor));
    expect(stepOf(store, "a")?.color).toBeUndefined();
  });

  test("the kebab menu has the note and colour items too", async () => {
    const store = storeOf(docOf({ a: { note: "hi" } }));
    render(<WorkflowCanvas store={store} />);
    fireEvent.pointerDown(
      within(cardOf("a")).getByRole("button", { name: L.actionsFor("Send email") }),
      {
        button: 0,
        pointerType: "mouse",
      },
    );
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText(L.editNote)).toBeTruthy();
    expect(within(menu).getByText(L.removeNote)).toBeTruthy();
    expect(within(menu).queryByText(L.addNote)).toBeNull();
    expect(within(menu).getByText(L.color)).toBeTruthy();
  });
});

describe("notes", () => {
  test("Add note opens the textarea; typing then blurring saves", async () => {
    const store = storeOf(docOf());
    render(<WorkflowCanvas store={store} />);
    const menu = await stepMenu("a");
    expect(within(menu).queryByText(L.editNote)).toBeNull();
    fireEvent.click(within(menu).getByText(L.addNote));
    const box = await screen.findByRole("textbox", { name: L.editNote });
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(box.getAttribute("maxlength")).toBe("4000");
    fireEvent.change(box, { target: { value: "Check with marketing" } });
    fireEvent.blur(box);
    expect(stepOf(store, "a")?.note).toBe("Check with marketing");
    expect(screen.queryByRole("textbox", { name: L.editNote })).toBeNull();
    expect(node("note:a").querySelector(".fl-note__text")?.textContent).toBe(
      "Check with marketing",
    );
  });

  test("clicking a note edits it; empty text plus blur removes the note", async () => {
    const store = storeOf(docOf({ a: { note: "old" } }));
    render(<WorkflowCanvas store={store} />);
    fireEvent.click(node("note:a").querySelector(".fl-note") as HTMLElement);
    const box = await screen.findByRole("textbox", { name: L.editNote });
    expect((box as HTMLTextAreaElement).value).toBe("old");
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.blur(box);
    expect(stepOf(store, "a")?.note).toBeUndefined();
    expect(document.querySelector('.react-flow__node[data-id="note:a"]')).toBeNull();
  });

  test("Enter on a focused note edits it", async () => {
    const store = storeOf(docOf({ a: { note: "old" } }));
    render(<WorkflowCanvas store={store} />);
    node("note:a").focus();
    fireEvent.keyDown(node("note:a"), { key: "Enter" });
    expect(await screen.findByRole("textbox", { name: L.editNote })).toBeTruthy();
    expect(store.getState().selection).toBeNull();
  });

  test("Esc cancels; ⌘Enter saves", async () => {
    const store = storeOf(docOf({ a: { note: "old" } }));
    render(<WorkflowCanvas store={store} />);
    fireEvent.click(node("note:a").querySelector(".fl-note") as HTMLElement);
    let box = await screen.findByRole("textbox", { name: L.editNote });
    fireEvent.change(box, { target: { value: "new" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(stepOf(store, "a")?.note).toBe("old");
    expect(screen.queryByRole("textbox", { name: L.editNote })).toBeNull();

    fireEvent.click(node("note:a").querySelector(".fl-note") as HTMLElement);
    box = await screen.findByRole("textbox", { name: L.editNote });
    fireEvent.change(box, { target: { value: "newer" } });
    fireEvent.keyDown(box, { key: "Enter", ...mod });
    expect(stepOf(store, "a")?.note).toBe("newer");
    expect(screen.queryByRole("textbox", { name: L.editNote })).toBeNull();
  });

  test("Remove note removes it, and the toast's Undo restores it", async () => {
    const store = storeOf(docOf({ a: { note: "keep me" } }));
    render(<WorkflowCanvas store={store} />);
    fireEvent.click(within(await stepMenu("a")).getByText(L.removeNote));
    expect(stepOf(store, "a")?.note).toBeUndefined();
    const toast = await screen.findByText(L.noteDeleted);
    fireEvent.click(
      within(toast.parentElement as HTMLElement).getByRole("button", { name: L.undo }),
    );
    expect(stepOf(store, "a")?.note).toBe("keep me");
  });

  test("Shorten on a 5000-char note clears note.tooLong; one undo restores it", async () => {
    const long = "x".repeat(5000);
    const store = storeOf(docOf({ a: { note: long } }));
    render(<WorkflowCanvas store={store} />);
    expect(codes(store)).toContain("note.tooLong");
    const before = store.getState().doc;
    fireEvent.click(within(node("note:a")).getByRole("button", { name: L.shortenNote }));
    expect(stepOf(store, "a")?.note).toHaveLength(4000);
    expect(codes(store)).not.toContain("note.tooLong");
    expect(within(node("note:a")).queryByRole("button", { name: L.shortenNote })).toBeNull();
    act(() => store.getState().undo());
    expect(store.getState().doc).toEqual(before);
    expect(codes(store)).toContain("note.tooLong");
  });
});

describe("section header", () => {
  test("after ⌘G the title input is focused; typing Owner loop and Enter saves", async () => {
    const store = storeOf(docOf());
    render(<WorkflowCanvas store={store} />);
    act(() => void store.getState().selectRange("a", "b"));
    fireEvent.keyDown(node("step:a"), { key: "g", ...mod });
    const input = await screen.findByRole("textbox", { name: L.sectionTitleInput });
    await waitFor(() => expect(document.activeElement).toBe(input));
    // Still focused once the chip's deferred focus has run.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "Owner loop" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(store.getState().doc.sections?.[0]?.title).toBe("Owner loop");
    expect(screen.queryByRole("textbox", { name: L.sectionTitleInput })).toBeNull();
  });

  test("Esc in the title input keeps Section", async () => {
    const store = storeOf(docOf());
    render(<WorkflowCanvas store={store} />);
    act(() => void store.getState().selectRange("a", "b"));
    fireEvent.keyDown(node("step:a"), { key: "g", ...mod });
    const input = await screen.findByRole("textbox", { name: L.sectionTitleInput });
    fireEvent.change(input, { target: { value: "Owner loop" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(store.getState().doc.sections?.[0]?.title).toBe("Section");
    expect(screen.queryByRole("textbox", { name: L.sectionTitleInput })).toBeNull();
  });

  test("Rename from the chip menu opens the title input; blur saves", async () => {
    const store = storeOf(docOf({ sections: [intro()] }));
    render(<WorkflowCanvas store={store} />);
    fireEvent.click(within(await chipMenu("intro")).getByText(L.renameSection));
    const input = await screen.findByRole("textbox", { name: L.sectionTitleInput });
    expect((input as HTMLInputElement).value).toBe("Welcome");
    fireEvent.change(input, { target: { value: "Onboarding" } });
    fireEvent.blur(input);
    expect(store.getState().doc.sections?.[0]?.title).toBe("Onboarding");
  });

  test("Color from the chip menu sets the section's colour", async () => {
    const store = storeOf(docOf({ sections: [intro()] }));
    render(<WorkflowCanvas store={store} />);
    const sub = await colorSubmenu(await chipMenu("intro"));
    fireEvent.click(within(sub).getByText(L.colorNames.green));
    expect(store.getState().doc.sections?.[0]?.color).toBe("green");
    expect(within(node("sectionHeader:intro")).getByRole("button").dataset.color).toBe("green");
  });

  test("Note from the chip menu edits the section note", async () => {
    const store = storeOf(docOf({ sections: [intro()] }));
    render(<WorkflowCanvas store={store} />);
    fireEvent.click(within(await chipMenu("intro")).getByText(L.sectionNote));
    const box = await screen.findByRole("textbox", { name: L.sectionNote });
    await waitFor(() => expect(document.activeElement).toBe(box));
    fireEvent.change(box, { target: { value: "First week" } });
    fireEvent.blur(box);
    expect(store.getState().doc.sections?.[0]?.note).toBe("First week");
  });

  test("Ungroup removes the section and keeps the steps; the toast's Undo restores it", async () => {
    const store = storeOf(docOf({ sections: [intro()] }));
    render(<WorkflowCanvas store={store} />);
    fireEvent.click(within(await chipMenu("intro")).getByText(L.ungroup));
    expect(store.getState().doc.sections ?? []).toHaveLength(0);
    expect(store.getState().doc.steps.map((s) => s.id)).toEqual(["load", "a", "b", "c"]);
    const toast = await screen.findByText(L.sectionDeleted("Welcome"));
    fireEvent.click(
      within(toast.parentElement as HTMLElement).getByRole("button", { name: L.undo }),
    );
    expect(store.getState().doc.sections).toEqual([intro()]);
  });

  test('the chip\'s Fix on a "red" section sets it to gray; one undo restores it', async () => {
    const store = storeOf(docOf({ sections: [intro({ color: "red" as AnnotationColor })] }));
    render(<WorkflowCanvas store={store} />);
    expect(codes(store)).toContain("section.broken");
    const before = store.getState().doc;
    const chip = within(node("sectionHeader:intro")).getByRole("button");
    expect(chip.querySelector(".fl-section-chip__warn")).toBeTruthy();
    fireEvent.click(within(await chipMenu("intro")).getByText(L.fixIssue));
    expect(store.getState().doc.sections?.[0]?.color).toBe("gray");
    expect(codes(store)).not.toContain("section.broken");
    expect(node("sectionHeader:intro").querySelector(".fl-section-chip__warn")).toBeNull();
    act(() => store.getState().undo());
    expect(store.getState().doc).toEqual(before);
  });

  test("the chip menu is named by sectionMenu(title), not after its trigger", async () => {
    render(<WorkflowCanvas store={storeOf(docOf({ sections: [intro({ note: "Hi" })] }))} />);
    const menu = await chipMenu("intro");
    expect(await screen.findByRole("menu", { name: L.sectionMenu("Welcome") })).toBe(menu);
    expect(menu.hasAttribute("aria-labelledby")).toBe(false);
  });

  test("a healthy section's menu has no Fix", async () => {
    render(<WorkflowCanvas store={storeOf(docOf({ sections: [intro()] }))} />);
    expect(within(await chipMenu("intro")).queryByText(L.fixIssue)).toBeNull();
  });
});

describe("read-only", () => {
  test("no menus, editors or Shorten", () => {
    const store = storeOf(docOf({ sections: [intro()], a: { note: "x".repeat(5000) } }), true);
    render(<WorkflowCanvas store={store} />);
    expect(within(node("sectionHeader:intro")).queryAllByRole("button")).toHaveLength(0);
    expect(within(node("note:a")).queryAllByRole("button")).toHaveLength(0);
    fireEvent.click(node("note:a").querySelector(".fl-note") as HTMLElement);
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.contextMenu(cardOf("a"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("labels", () => {
  test("new strings come from labels: ungroup can be overridden", async () => {
    const store = storeOf(docOf({ sections: [intro()] }));
    render(
      <FlowlineProvider client={mockClient()} labels={{ ungroup: "Dégrouper" }}>
        <WorkflowCanvas store={store} />
      </FlowlineProvider>,
    );
    const menu = await chipMenu("intro");
    expect(within(menu).getByText("Dégrouper")).toBeTruthy();
    expect(within(menu).queryByText(L.ungroup)).toBeNull();
  });
});

/** Replaces the store's `setNote` with a spy, calling through unless `impl` is given. */
function spyOnSetNote(store: EditorStore, impl?: (id: string, note: string | null) => void) {
  const real = store.getState().setNote;
  const spy = vi.fn(impl ?? real);
  store.setState({ setNote: spy });
  return spy;
}

/**
 * Collects uncaught errors: React 19 reports an error thrown in an event handler
 * asynchronously (window "error", console.error), so `expect(...).not.toThrow()` can't see it.
 */
function watchErrors(): { seen: unknown[]; stop(): void } {
  const seen: unknown[] = [];
  const onError = (e: ErrorEvent) => {
    seen.push(e.error ?? e.message);
    e.preventDefault();
  };
  window.addEventListener("error", onError);
  const log = vi.spyOn(console, "error").mockImplementation((...args) => void seen.push(args));
  return {
    seen,
    stop() {
      window.removeEventListener("error", onError);
      log.mockRestore();
    },
  };
}

describe("review round 1", () => {
  const long = "x".repeat(5000);
  const noteBox = () => screen.findByRole("textbox", { name: L.editNote });
  const openNote = (id: string) =>
    fireEvent.click(node(`note:${id}`).querySelector(".fl-note") as HTMLElement);

  test("I1: blurring an untouched over-long note saves nothing and throws nothing", async () => {
    const store = storeOf(docOf({ a: { note: long } }));
    render(<WorkflowCanvas store={store} />);
    const setNote = spyOnSetNote(store);
    const errors = watchErrors();
    const before = store.getState().doc;
    openNote("a");
    fireEvent.blur(await noteBox());
    await new Promise((r) => setTimeout(r, 0));
    errors.stop();
    expect(setNote).not.toHaveBeenCalled();
    expect(errors.seen).toEqual([]);
    expect(store.getState().doc).toBe(before);
    expect(screen.queryByRole("textbox", { name: L.editNote })).toBeNull();
  });

  test("I1: an edited note still over the limit keeps the editor open; Shorten saves 4000", async () => {
    const store = storeOf(docOf({ a: { note: long } }));
    render(<WorkflowCanvas store={store} />);
    openNote("a");
    const box = await noteBox();
    fireEvent.change(box, { target: { value: "y".repeat(4500) } });
    fireEvent.blur(box);
    expect(stepOf(store, "a")?.note).toBe(long);
    expect(screen.getByRole("textbox", { name: L.editNote })).toBe(box);
    expect(box.getAttribute("aria-invalid")).toBe("true");
    const hint = screen.getByText(L.noteTooLong(4500, 4000));
    fireEvent.click(
      within(hint.parentElement as HTMLElement).getByRole("button", { name: L.shortenNote }),
    );
    expect(stepOf(store, "a")?.note).toBe("y".repeat(4000));
    expect(screen.queryByRole("textbox", { name: L.editNote })).toBeNull();
  });

  test("I1: the same for an over-long section note", async () => {
    const store = storeOf(docOf({ sections: [intro({ note: long })] }));
    render(<WorkflowCanvas store={store} />);
    const before = store.getState().doc;
    fireEvent.click(within(await chipMenu("intro")).getByText(L.sectionNote));
    let box = await screen.findByRole("textbox", { name: L.sectionNote });
    expect(() => fireEvent.blur(box)).not.toThrow();
    expect(store.getState().doc).toBe(before);
    fireEvent.click(within(await chipMenu("intro")).getByText(L.sectionNote));
    box = await screen.findByRole("textbox", { name: L.sectionNote });
    fireEvent.change(box, { target: { value: "z".repeat(4200) } });
    fireEvent.blur(box);
    expect(store.getState().doc.sections?.[0]?.note).toBe(long);
    const hint = screen.getByText(L.noteTooLong(4200, 4000));
    fireEvent.click(
      within(hint.parentElement as HTMLElement).getByRole("button", { name: L.shortenNote }),
    );
    expect(store.getState().doc.sections?.[0]?.note).toBe("z".repeat(4000));
  });

  test("I1: a rejected save toasts the error instead of throwing", async () => {
    const store = storeOf(docOf({ a: { note: "old" } }));
    render(<WorkflowCanvas store={store} />);
    const rejection = new FlowlineCommandError({
      index: 0,
      path: "commands[0]",
      code: "command.invalid",
      message: "Rejected by the test",
    } as ApplyError);
    const setNote = spyOnSetNote(store, () => {
      throw rejection;
    });
    const errors = watchErrors();
    openNote("a");
    const box = await noteBox();
    fireEvent.change(box, { target: { value: "new" } });
    fireEvent.blur(box);
    await new Promise((r) => setTimeout(r, 0));
    errors.stop();
    expect(setNote).toHaveBeenCalledWith("a", "new");
    expect(errors.seen).toEqual([]);
    expect(await screen.findByText("Rejected by the test")).toBeTruthy();
    expect(stepOf(store, "a")?.note).toBe("old");
  });

  const dupes = (): Section[] => [
    { id: "s", title: "One", color: "blue", first: "a", last: "a" },
    { id: "s", title: "Two", color: "pink", first: "c", last: "c" },
  ];
  const chipOf = (nodeId: string) => within(node(nodeId)).getByRole("button");
  async function menuOf(nodeId: string): Promise<HTMLElement> {
    fireEvent.pointerDown(chipOf(nodeId), { button: 0, pointerType: "mouse" });
    return screen.findByRole("menu");
  }
  const closeMenu = async (menu: HTMLElement) => {
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  };

  test("I2: with a repeated section ID only the last chip edits; the others offer only Fix", async () => {
    const store = storeOf(docOf({ sections: dupes() }));
    render(<WorkflowCanvas store={store} />);
    const first = await menuOf("sectionHeader:s");
    for (const item of [L.renameSection, L.color, L.sectionNote, L.ungroup]) {
      expect(within(first).queryByText(item)).toBeNull();
    }
    expect(within(first).getByText(L.fixIssue)).toBeTruthy();
    await closeMenu(first);

    fireEvent.click(within(await menuOf("sectionHeader:s~1")).getByText(L.renameSection));
    const inputs = await screen.findAllByRole("textbox", { name: L.sectionTitleInput });
    expect(inputs).toHaveLength(1);
    const input = inputs[0] as HTMLElement;
    expect(node("sectionHeader:s~1").contains(input)).toBe(true);
    fireEvent.change(input, { target: { value: "Second" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(store.getState().doc.sections?.map((s) => s.title)).toEqual(["One", "Second"]);
    // Let the chip's deferred refocus run before opening its menu again.
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const sub = await colorSubmenu(await menuOf("sectionHeader:s~1"));
    fireEvent.click(within(sub).getByText(L.colorNames.green));
    expect(store.getState().doc.sections?.map((s) => s.color)).toEqual(["blue", "green"]);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    fireEvent.click(within(await menuOf("sectionHeader:s~1")).getByText(L.ungroup));
    expect(store.getState().doc.sections?.map((s) => s.title)).toEqual(["One"]);
    expect(await screen.findByText(L.sectionDeleted("Second"))).toBeTruthy();
  });

  test("I3: an agent edit made while the note editor is open survives an unchanged blur", async () => {
    const store = storeOf(docOf({ a: { note: "old" } }));
    render(<WorkflowCanvas store={store} />);
    openNote("a");
    const box = await noteBox();
    act(() => void store.getState().apply([{ op: "setNote", id: "a", note: "agent" }]));
    fireEvent.blur(screen.queryByRole("textbox", { name: L.editNote }) ?? box);
    expect(stepOf(store, "a")?.note).toBe("agent");
  });

  test("I3: the same for a section title", async () => {
    const store = storeOf(docOf({ sections: [intro()] }));
    render(<WorkflowCanvas store={store} />);
    fireEvent.click(within(await chipMenu("intro")).getByText(L.renameSection));
    const input = await screen.findByRole("textbox", { name: L.sectionTitleInput });
    act(() => void store.getState().apply([{ op: "updateSection", id: "intro", title: "Agent" }]));
    fireEvent.blur(input);
    expect(store.getState().doc.sections?.[0]?.title).toBe("Agent");
  });

  test("I3: a draft survives a rename of its step", async () => {
    const store = storeOf(docOf({ a: { note: "old" } }));
    render(<WorkflowCanvas store={store} />);
    openNote("a");
    fireEvent.change(await noteBox(), { target: { value: "draft" } });
    act(() => void store.getState().apply([{ op: "renameStepId", id: "a", newId: "a2" }]));
    const box = await noteBox();
    expect(node("note:a2").contains(box)).toBe(true);
    expect((box as HTMLTextAreaElement).value).toBe("draft");
    fireEvent.blur(box);
    expect(stepOf(store, "a2")?.note).toBe("draft");
  });

  test("I3: removing the step closes the editor; undo doesn't reopen it", async () => {
    const store = storeOf(docOf({ a: { note: "old" } }));
    render(<WorkflowCanvas store={store} />);
    openNote("a");
    fireEvent.change(await noteBox(), { target: { value: "draft" } });
    expect(() =>
      act(() => void store.getState().apply([{ op: "removeStep", id: "a" }])),
    ).not.toThrow();
    expect(screen.queryByRole("textbox", { name: L.editNote })).toBeNull();
    act(() => store.getState().undo());
    expect(stepOf(store, "a")?.note).toBe("old");
    expect(screen.queryByRole("textbox", { name: L.editNote })).toBeNull();
  });

  test("M2: Remove note right after an edit is its own undo step", async () => {
    const store = storeOf(docOf({ a: { note: "old" } }));
    render(<WorkflowCanvas store={store} />);
    openNote("a");
    const box = await noteBox();
    fireEvent.change(box, { target: { value: "edited" } });
    fireEvent.blur(box);
    expect(stepOf(store, "a")?.note).toBe("edited");
    fireEvent.click(within(await stepMenu("a")).getByText(L.removeNote));
    expect(stepOf(store, "a")?.note).toBeUndefined();
    const toast = await screen.findByText(L.noteDeleted);
    fireEvent.click(
      within(toast.parentElement as HTMLElement).getByRole("button", { name: L.undo }),
    );
    expect(stepOf(store, "a")?.note).toBe("edited");
  });
});
