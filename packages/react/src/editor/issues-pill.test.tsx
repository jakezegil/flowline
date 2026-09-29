import type { Section, WorkflowDoc } from "@flowlinejs/core";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { setupDom } from "../../test/dom";
import { docWith, manifest, step } from "../../test/fixtures";
import { EditorContext } from "../hooks";
import { defaultLabels as L } from "../labels";
import { createEditorStore, type EditorStore, TRIGGER_KEY } from "../store/editor-store";
import { ToasterProvider } from "../ui/toaster";
import { IssuesPill, issueTargets } from "./issues-pill";

beforeAll(setupDom);
afterEach(cleanup);

const email = (id: string) => step(id, "crm.sendEmail", { to: "a@b.c", subject: id });

function docOf(sections: Section[]): WorkflowDoc {
  const doc = docWith([
    step("load", "crm.loadContact", { contactId: { $ref: "trigger.contactId" } }),
    email("a"),
    email("b"),
  ]);
  doc.sections = sections;
  return doc;
}

function renderPill(store: EditorStore) {
  return render(
    <Tooltip.Provider delayDuration={0}>
      <ToasterProvider>
        <EditorContext.Provider value={store}>
          <IssuesPill />
        </EditorContext.Provider>
      </ToasterProvider>
    </Tooltip.Provider>,
  );
}

const codes = (store: EditorStore) => store.getState().issues.map((i) => i.code);
const fix = () => screen.getByRole("button", { name: L.fixIssue });
const pill = () => document.querySelector(".fl-issues") as HTMLElement;

describe("issues pill Fix", () => {
  test("Fix on a broken section (missing first) shrinks it; one undo restores it", () => {
    const store = createEditorStore({
      doc: docOf([{ id: "s", title: "S", color: "blue", first: "ghost", last: "b" }]),
      manifest,
    });
    renderPill(store);
    expect(codes(store)).toContain("section.broken");
    const before = store.getState().doc;
    fireEvent.click(pill());
    fireEvent.click(fix());
    expect(store.getState().doc.sections).toEqual([
      { id: "s", title: "S", color: "blue", first: "b", last: "b" },
    ]);
    expect(codes(store)).not.toContain("section.broken");
    act(() => store.getState().undo());
    expect(store.getState().doc).toEqual(before);
  });

  test("Fix on a section missing first and last removes it; one undo restores it", () => {
    const store = createEditorStore({
      doc: docOf([{ id: "s", title: "S", color: "blue", first: "ghost", last: "gone" }]),
      manifest,
    });
    renderPill(store);
    const before = store.getState().doc;
    fireEvent.click(pill());
    fireEvent.click(fix());
    expect(store.getState().doc.sections ?? []).toEqual([]);
    expect(codes(store)).not.toContain("section.broken");
    act(() => store.getState().undo());
    expect(store.getState().doc).toEqual(before);
  });

  test("no Fix for an issue without a repair, nor on a read-only store", () => {
    const doc = docOf([]);
    (doc.steps[1] as { config: Record<string, unknown> }).config = {};
    const store = createEditorStore({ doc, manifest });
    renderPill(store);
    expect(store.getState().issues.length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: L.fixIssue })).toBeNull();
    cleanup();
    const ro = createEditorStore({
      doc: docOf([{ id: "s", title: "S", color: "blue", first: "ghost", last: "b" }]),
      manifest,
      readOnly: true,
    });
    renderPill(ro);
    fireEvent.click(pill());
    expect(screen.queryByRole("button", { name: L.fixIssue })).toBeNull();
  });

  test("a section issue without a first step groups under its section, not the trigger", () => {
    const doc = docOf([{ id: "s", title: "S", color: "blue", first: "ghost", last: "b" }]);
    const store = createEditorStore({ doc, manifest });
    const targets = issueTargets(doc, store.getState().issues);
    expect(targets.map((t) => t.key)).not.toContain(TRIGGER_KEY);
    expect(targets.map((t) => t.key)).toContain("section:s");
  });

  test("Fix shows only for the selection's (or the cycled-to) issue, never some other one", () => {
    const doc = docOf([]);
    (doc.steps[2] as { note?: string }).note = "x".repeat(5000);
    const store = createEditorStore({ doc, manifest });
    renderPill(store);
    expect(codes(store)).toContain("note.tooLong");
    // Nothing selected, not cycling: no Fix for an issue elsewhere.
    expect(screen.queryByRole("button", { name: L.fixIssue })).toBeNull();
    act(() => store.getState().select("a"));
    expect(screen.queryByRole("button", { name: L.fixIssue })).toBeNull();
    act(() => store.getState().select("b"));
    expect(fix()).toBeTruthy();
  });

  test("a Fix toasts 'Fixed: …' with Undo, and focus stays on the pill", async () => {
    const doc = docOf([{ id: "s", title: "S", color: "blue", first: "ghost", last: "b" }]);
    // An issue Fix can't repair keeps the pill up.
    (doc.steps[1] as { config: Record<string, unknown> }).config = {};
    const store = createEditorStore({ doc, manifest });
    renderPill(store);
    const before = store.getState().doc;
    fireEvent.click(pill());
    if (store.getState().selection === "a") fireEvent.click(pill());
    const message = store.getState().issues.find((i) => i.code === "section.broken")?.message;
    const button = fix();
    button.focus();
    fireEvent.click(button);
    const toast = await screen.findByText(L.issueFixed(message as string));
    await waitFor(() => expect(document.activeElement).toBe(pill()));
    fireEvent.click(
      within(toast.parentElement as HTMLElement).getByRole("button", { name: L.undo }),
    );
    expect(store.getState().doc).toEqual(before);
  });

  test("while cycling, the hint names the issue Fix repairs, not the step's headline issue", async () => {
    const doc = docOf([]);
    (doc.steps[1] as { config: Record<string, unknown>; note?: string }).config = {};
    (doc.steps[1] as { note?: string }).note = "x".repeat(5000);
    const store = createEditorStore({ doc, manifest });
    renderPill(store);
    const onA = store.getState().issues.filter((i) => i.stepId === "a");
    const tooLong = onA.find((i) => i.code === "note.tooLong");
    const headline = issueTargets(doc, store.getState().issues).find((t) => t.key === "a");
    expect(headline?.issue.code).not.toBe("note.tooLong");
    fireEvent.click(pill());
    expect(store.getState().selection).toBe("a");
    expect(fix().getAttribute("aria-description")).toBe(tooLong?.message);
    act(() => pill().focus());
    const tip = await screen.findAllByText(new RegExp(`: ${tooLong?.message.slice(0, 20)}`));
    expect(tip.length).toBeGreaterThan(0);
    expect(screen.queryAllByText(new RegExp(`: ${headline?.issue.message}`))).toHaveLength(0);
  });
});
