import type { Manifest, Step, WorkflowDetail, WorkflowDoc } from "@flowlinejs/core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { setupCodeMirrorDom } from "../../test/codemirror-dom";
import { mockClient } from "../../test/dom";
import { docWith, manifest, step } from "../../test/fixtures";
import { deleteTarget } from "../canvas/delete-key";
import { FlowlineProvider } from "../provider";
import { type EditorStore, TRIGGER_KEY } from "../store/editor-store";
import { WorkflowEditor } from "./workflow-editor";

/**
 * Task 15: Backspace/Delete delete the selection from the canvas, from non-text controls in the
 * side panel and from annotations; never while typing (Review Focus 5).
 */

beforeAll(setupCodeMirrorDom);
beforeEach(() => localStorage.clear());
afterEach(cleanup);

/** The fixture manifest, with a number field ("Retries", a plain text input) on Send email. */
const testManifest: Manifest = {
  ...manifest,
  nodes: manifest.nodes.map((n) =>
    n.type === "crm.sendEmail"
      ? {
          ...n,
          input: {
            ...n.input,
            properties: {
              ...(n.input.properties as Record<string, unknown>),
              retries: { type: "integer", "x-flowline": { label: "Retries" } },
            },
          },
        }
      : n,
  ),
};

function detail(doc: WorkflowDoc): WorkflowDetail {
  const v = { workflowId: doc.id, tenantId: "t", version: 3, doc, createdBy: "u", createdAt: 0 };
  return { latest: v, published: null };
}

/** load → email ("Send email") → email2 ("Follow-up"). */
function threeSteps(extra: { note?: string } = {}): WorkflowDoc {
  const email: Step = step("email", "crm.sendEmail", {
    to: { $ref: "steps.load.email" },
    subject: "Hi",
    retries: 42,
  });
  if (extra.note !== undefined) email.note = extra.note;
  return docWith([
    step("load", "crm.loadContact", { contactId: { $ref: "trigger.contactId" } }),
    email,
    step("email2", "crm.sendEmail", { to: "a@b.c", subject: "Hey" }, { name: "Follow-up" }),
  ]);
}

type User = ReturnType<typeof userEvent.setup>;

async function setup(doc: WorkflowDoc = threeSteps()) {
  const client = mockClient({
    getManifest: async () => testManifest,
    listSubflows: async () => [],
    listSecrets: async () => [],
    getWorkflow: async () => detail(doc),
  });
  let store: EditorStore | undefined;
  const user = userEvent.setup();
  render(
    <FlowlineProvider client={client}>
      <button type="button">Outside</button>
      <div style={{ height: 800 }}>
        <WorkflowEditor
          workflowId={doc.id}
          onStoreReady={(s) => {
            store = s;
          }}
        />
      </div>
    </FlowlineProvider>,
  );
  await screen.findByText("Draft · v3");
  const s = store as EditorStore;
  return { store: s, user, ids: () => s.getState().doc.steps.map((x) => x.id) };
}

const node = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
  if (!el) throw new Error(`no node ${id}`);
  return el;
};
const card = (id: string) => node(`step:${id}`);

/** Clicks the card of `id` (selecting it and opening the panel), then focuses `.fl-cp__name-btn`. */
async function selectAndFocusPanel(user: User, id: string) {
  await user.click(card(id).querySelector(".fl-card") as HTMLElement);
  const nameBtn = await waitFor(() => {
    const el = document.querySelector<HTMLElement>(".fl-cp__name-btn");
    if (!el) throw new Error("no panel");
    return el;
  });
  nameBtn.focus();
  return nameBtn;
}

/**
 * The positive control of a "does not delete" case: once focus moves to the panel's name
 * button, Backspace deletes the selection (`gone` leaves the doc). So each case fails without the
 * feature, not only with an over-eager one.
 */
async function deletesFromPanel(user: User, ids: () => string[], gone = "email") {
  const btn = document.querySelector<HTMLElement>(".fl-cp__name-btn");
  expect(btn).not.toBeNull();
  btn?.focus();
  await user.keyboard("{Backspace}");
  expect(ids()).not.toContain(gone);
}

/** Collects the window `error` events (errors thrown from event handlers) while `run` runs. */
async function windowErrors(run: () => Promise<void>): Promise<unknown[]> {
  const errors: unknown[] = [];
  const onError = (e: ErrorEvent) => errors.push(e.error);
  window.addEventListener("error", onError);
  try {
    await run();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    window.removeEventListener("error", onError);
  }
  return errors;
}

describe("Backspace/Delete in the editor", () => {
  test("regression: Backspace with the panel's name button focused deletes the step", async () => {
    const { user, ids } = await setup();
    await selectAndFocusPanel(user, "email");
    expect(document.activeElement?.classList.contains("fl-cp__name-btn")).toBe(true);
    await user.keyboard("{Backspace}");
    expect(ids()).toEqual(["load", "email2"]);
    expect(await screen.findByText("Deleted “Send email”")).toBeTruthy();
    // Focus goes to the neighbour's card, never to <body>.
    await waitFor(() => expect(document.activeElement).toBe(card("email2")));
  });

  test("canvas card: deletes (and so does its focused “…” button)", async () => {
    const { user, store, ids } = await setup();
    act(() => store.getState().select("email"));
    card("email").focus();
    await user.keyboard("{Delete}");
    expect(ids()).toEqual(["load", "email2"]);
    await waitFor(() => expect(document.activeElement).toBe(card("email2")));
    (card("email2").querySelector(".fl-card__kebab") as HTMLElement).focus();
    await user.keyboard("{Backspace}");
    expect(ids()).toEqual(["load"]);
  });

  test("panel tab button: deletes", async () => {
    const { user, ids } = await setup();
    await selectAndFocusPanel(user, "email");
    screen.getByRole("tab", { name: /^Configure/ }).focus();
    await user.keyboard("{Backspace}");
    expect(ids()).toEqual(["load", "email2"]);
  });

  test("exactly one deletion (one undo step) per keypress", async () => {
    const { user, store, ids } = await setup();
    await selectAndFocusPanel(user, "email");
    expect(store.getState().canUndo).toBe(false);
    await user.keyboard("{Backspace}");
    expect(ids()).toEqual(["load", "email2"]);
    act(() => store.getState().undo());
    expect(ids()).toEqual(["load", "email", "email2"]);
    expect(store.getState().canUndo).toBe(false);
  });

  test("panel config text input: does not delete; the character is removed", async () => {
    const { user, ids } = await setup();
    await selectAndFocusPanel(user, "email");
    const input = screen.getByRole("textbox", { name: "Retries" }) as HTMLInputElement;
    expect(input.value).toBe("42");
    await user.click(input);
    input.setSelectionRange(2, 2);
    await user.keyboard("{Backspace}");
    expect(input.value).toBe("4");
    expect(ids()).toEqual(["load", "email", "email2"]);
    await deletesFromPanel(user, ids);
  });

  test("panel name input (rename mode): does not delete", async () => {
    const { user, ids } = await setup();
    const btn = await selectAndFocusPanel(user, "email");
    await user.click(btn);
    const input = await screen.findByRole("textbox", { name: "Rename step" });
    expect(document.activeElement).toBe(input);
    await user.keyboard("{Backspace}{Delete}");
    expect(ids()).toEqual(["load", "email", "email2"]);
    // Enter ends the rename and focus returns to the name button, where Backspace deletes.
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(document.activeElement?.classList.contains("fl-cp__name-btn")).toBe(true),
    );
    await deletesFromPanel(user, ids);
  });

  test("inline card rename input: does not delete", async () => {
    const { user, store, ids } = await setup();
    act(() => store.getState().select("email"));
    card("email").focus();
    await user.keyboard("{F2}");
    const input = await screen.findByRole("textbox", { name: "Step name" });
    await waitFor(() => expect(document.activeElement).toBe(input));
    await user.keyboard("{Backspace}{Delete}");
    expect(ids()).toEqual(["load", "email", "email2"]);
    await deletesFromPanel(user, ids);
  });

  test("CodeMirror editor: does not delete", async () => {
    const { user, ids } = await setup();
    await selectAndFocusPanel(user, "email");
    const content = document.querySelector<HTMLElement>('.cm-content[aria-label="Subject"]');
    expect(content).not.toBeNull();
    content?.focus();
    await user.keyboard("{Backspace}{Delete}");
    fireEvent.keyDown(content as HTMLElement, { key: "Backspace" });
    expect(ids()).toEqual(["load", "email", "email2"]);
    await deletesFromPanel(user, ids);
  });

  test("data-picker search: does not delete", async () => {
    const { user, ids } = await setup();
    await selectAndFocusPanel(user, "email");
    const content = document.querySelector<HTMLElement>('.cm-content[aria-label="Subject"]');
    act(() => {
      fireEvent.focus(content as HTMLElement);
    });
    const search = await screen.findByRole("combobox", { name: "Search data" });
    search.focus();
    await user.keyboard("x{Backspace}{Backspace}{Delete}");
    expect(ids()).toEqual(["load", "email", "email2"]);
    await deletesFromPanel(user, ids);
  });

  test("note textarea: does not delete", async () => {
    const { user, store, ids } = await setup(threeSteps({ note: "hello" }));
    act(() => store.getState().select("email"));
    await user.click(node("note:email").querySelector(".fl-note") as HTMLElement);
    const textarea = await waitFor(() => {
      const el = node("note:email").querySelector("textarea");
      if (!el) throw new Error("no editor");
      return el;
    });
    textarea.focus();
    textarea.setSelectionRange(5, 5);
    await user.keyboard("{Backspace}{Delete}");
    expect(ids()).toEqual(["load", "email", "email2"]);
    expect(textarea.value).toBe("hell");
    await deletesFromPanel(user, ids);
  });

  test("section title input: does not delete", async () => {
    const { user, store, ids } = await setup();
    act(() => store.getState().select("email"));
    card("email").focus();
    await user.keyboard("{Control>}g{/Control}");
    const input = await screen.findByRole("textbox", { name: "Section title" });
    await waitFor(() => expect(document.activeElement).toBe(input));
    await user.keyboard("{Backspace}{Delete}");
    expect(ids()).toEqual(["load", "email", "email2"]);
    expect(store.getState().doc.sections?.length).toBe(1);
    await deletesFromPanel(user, ids);
  });

  test("section chip: deletes the section only", async () => {
    const doc = threeSteps();
    doc.sections = [{ id: "s", title: "Intro", color: "blue", first: "load", last: "email" }];
    const { user, store, ids } = await setup(doc);
    act(() => store.getState().select("email2"));
    const chip = node("sectionHeader:s").querySelector("button") as HTMLElement;
    chip.focus();
    await user.keyboard("{Backspace}");
    expect(store.getState().doc.sections ?? []).toEqual([]);
    expect(ids()).toEqual(["load", "email", "email2"]);
    expect(await screen.findByText("Removed section “Intro”")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(card("load")));
  });

  test("section chip of a repeated ID's earlier occurrence: deletes nothing", async () => {
    const doc = threeSteps();
    doc.sections = [
      { id: "s", title: "One", color: "blue", first: "load", last: "load" },
      { id: "s", title: "Two", color: "green", first: "email2", last: "email2" },
    ];
    const { user, store, ids } = await setup(doc);
    act(() => store.getState().select("email"));
    const before = store.getState().doc.sections;
    (node("sectionHeader:s").querySelector("button") as HTMLElement).focus();
    await user.keyboard("{Backspace}");
    // Neither section (the last one is what `removeSection("s")` would remove) nor the step.
    expect(store.getState().doc.sections).toBe(before);
    expect(ids()).toEqual(["load", "email", "email2"]);
    // The last occurrence, the one commands act on, does delete.
    (node("sectionHeader:s~1").querySelector("button") as HTMLElement).focus();
    await user.keyboard("{Backspace}");
    expect(store.getState().doc.sections).toEqual([
      { id: "s", title: "One", color: "blue", first: "load", last: "load" },
    ]);
  });

  test("note: deletes the note only", async () => {
    const { user, store, ids } = await setup(threeSteps({ note: "hello" }));
    act(() => store.getState().select("email2"));
    node("note:email").focus();
    await user.keyboard("{Delete}");
    expect(store.getState().doc.steps[1]?.note).toBeUndefined();
    expect(ids()).toEqual(["load", "email", "email2"]);
    expect(await screen.findByText("Note removed")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(card("email")));
  });

  test("panel, with a range selected: deletes the range", async () => {
    const { user, store, ids } = await setup();
    await selectAndFocusPanel(user, "email");
    act(() => {
      store.getState().selectRange("email", "email2");
    });
    (document.querySelector(".fl-cp__name-btn") as HTMLElement).focus();
    await user.keyboard("{Backspace}");
    expect(ids()).toEqual(["load"]);
    expect(await screen.findByText("Deleted 2 steps")).toBeTruthy();
  });

  test("canvas card outside the range deletes that card; from the panel, the range", async () => {
    const { user, store, ids } = await setup();
    act(() => {
      store.getState().select("email");
      store.getState().selectRange("email", "email2");
    });
    card("load").focus();
    await user.keyboard("{Backspace}");
    expect(ids()).toEqual(["email", "email2"]);
    await deletesFromPanel(user, ids, "email2");
    expect(ids()).toEqual([]);
  });

  test("canvas card inside the range: deletes the range", async () => {
    const { user, store, ids } = await setup();
    act(() => {
      store.getState().selectRange("email", "email2");
    });
    card("email2").focus();
    await user.keyboard("{Backspace}");
    expect(ids()).toEqual(["load"]);
  });

  test("trigger selected: nothing", async () => {
    const { user, store, ids } = await setup();
    await user.click(node("trigger").querySelector(".fl-card") as HTMLElement);
    expect(store.getState().selection).toBe(TRIGGER_KEY);
    const heading = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".fl-panel [data-autofocus]");
      if (!el) throw new Error("no panel");
      return el;
    });
    heading.focus();
    await user.keyboard("{Backspace}");
    node("trigger").focus();
    await user.keyboard("{Delete}");
    expect(ids()).toEqual(["load", "email", "email2"]);
    act(() => store.getState().select("email"));
    await deletesFromPanel(user, ids);
  });

  test("read-only editor: nothing, and nothing throws", async () => {
    const { user, store, ids } = await setup();
    await selectAndFocusPanel(user, "email");
    act(() => store.getState().setReadOnly(true));
    const removeStep = store.getState().removeStep;
    let calls = 0;
    store.setState({
      removeStep: (...args: Parameters<typeof removeStep>) => {
        calls++;
        return removeStep(...args);
      },
    });
    const errors = await windowErrors(async () => {
      (document.querySelector(".fl-panel [data-autofocus]") as HTMLElement).focus();
      await user.keyboard("{Backspace}");
      card("email").focus();
      await user.keyboard("{Delete}");
      fireEvent.pointerDown(card("email"));
      (document.activeElement as HTMLElement | null)?.blur();
      fireEvent.keyDown(document.body, { key: "Backspace" });
    });
    expect(calls).toBe(0);
    expect(errors).toEqual([]);
    expect(ids()).toEqual(["load", "email", "email2"]);
    act(() => store.getState().setReadOnly(false));
    await deletesFromPanel(user, ids);
    expect(calls).toBe(1);
  });

  test("document.body, after clicking in the editor: deletes", async () => {
    const { user, ids } = await setup();
    await selectAndFocusPanel(user, "email");
    fireEvent.pointerDown(document.querySelector(".fl-panel") as HTMLElement);
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "Backspace" });
    expect(ids()).toEqual(["load", "email2"]);
  });

  test("document.body, after clicking outside the editor: nothing", async () => {
    const { user, ids } = await setup();
    await selectAndFocusPanel(user, "email");
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: "Backspace" });
    expect(ids()).toEqual(["load", "email", "email2"]);
    // A click back in the editor makes <body> keys its own again.
    fireEvent.pointerDown(document.querySelector(".fl-panel") as HTMLElement);
    fireEvent.keyDown(document.body, { key: "Backspace" });
    expect(ids()).toEqual(["load", "email2"]);
  });

  test("a store error from the handler goes to a toast, not a thrown error", async () => {
    const { user, store, ids } = await setup();
    await selectAndFocusPanel(user, "email");
    // The store turns read-only between the key's check and the edit (e.g. a host's hold).
    const removeStep = store.getState().removeStep;
    store.setState({
      removeStep: (...args: Parameters<typeof removeStep>) => {
        store.getState().setReadOnly(true);
        return removeStep(...args);
      },
    });
    const errors = await windowErrors(async () => {
      await user.keyboard("{Backspace}");
    });
    expect(errors).toEqual([]);
    expect(ids()).toEqual(["load", "email", "email2"]);
    expect(await screen.findByText("The editor is read-only")).toBeTruthy();
  });
});

describe("deleteTarget", () => {
  const ev = (
    target: EventTarget | null,
    key = "Backspace",
    mods: Partial<KeyboardEvent> = {},
  ) => ({
    key,
    target,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...mods,
  });
  const state = { selection: "a", range: null, readOnly: false };

  test("only plain Delete/Backspace count", () => {
    const btn = document.createElement("button");
    document.body.append(btn);
    expect(deleteTarget(ev(btn), state)).toEqual({ kind: "step", id: "a" });
    expect(deleteTarget(ev(btn, "Delete"), state)).toEqual({ kind: "step", id: "a" });
    expect(deleteTarget(ev(btn, "x"), state)).toBeNull();
    expect(deleteTarget(ev(btn, "Backspace", { metaKey: true }), state)).toBeNull();
    expect(deleteTarget(ev(btn, "Backspace", { ctrlKey: true }), state)).toBeNull();
    expect(deleteTarget(ev(btn, "Backspace", { altKey: true }), state)).toBeNull();
    btn.remove();
  });

  test("editable targets, read-only and the trigger give null; a range wins over the step", () => {
    const input = document.createElement("input");
    document.body.append(input);
    expect(deleteTarget(ev(input), state)).toBeNull();
    expect(deleteTarget(ev(document.body), { ...state, readOnly: true })).toBeNull();
    expect(deleteTarget(ev(document.body), { ...state, selection: TRIGGER_KEY })).toBeNull();
    expect(deleteTarget(ev(document.body), { ...state, selection: null })).toBeNull();
    expect(deleteTarget(ev(document.body), { ...state, range: { first: "a", last: "b" } })).toEqual(
      { kind: "range", first: "a", last: "b" },
    );
    input.remove();
  });
});
