import {
  type AnnotationColor,
  findStep,
  type Section,
  type Step,
  type WorkflowDoc,
} from "@flowlinejs/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
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
