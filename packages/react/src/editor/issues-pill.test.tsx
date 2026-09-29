import type { Section, WorkflowDoc } from "@flowlinejs/core";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { setupDom } from "../../test/dom";
import { docWith, manifest, step } from "../../test/fixtures";
import { EditorContext } from "../hooks";
import { defaultLabels as L } from "../labels";
import { createEditorStore, type EditorStore, TRIGGER_KEY } from "../store/editor-store";
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
    <Tooltip.Provider>
      <EditorContext.Provider value={store}>
        <IssuesPill />
      </EditorContext.Provider>
    </Tooltip.Provider>,
  );
}

const codes = (store: EditorStore) => store.getState().issues.map((i) => i.code);
const fix = () => screen.getByRole("button", { name: L.fixIssue });

describe("issues pill Fix", () => {
  test("Fix on a broken section (missing first) shrinks it; one undo restores it", () => {
    const store = createEditorStore({
      doc: docOf([{ id: "s", title: "S", color: "blue", first: "ghost", last: "b" }]),
      manifest,
    });
    renderPill(store);
    expect(codes(store)).toContain("section.broken");
    const before = store.getState().doc;
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
    expect(screen.queryByRole("button", { name: L.fixIssue })).toBeNull();
  });

  test("a section issue without a first step groups under its section, not the trigger", () => {
    const doc = docOf([{ id: "s", title: "S", color: "blue", first: "ghost", last: "b" }]);
    const store = createEditorStore({ doc, manifest });
    const targets = issueTargets(doc, store.getState().issues);
    expect(targets.map((t) => t.key)).not.toContain(TRIGGER_KEY);
    expect(targets.map((t) => t.key)).toContain("section:s");
  });
});
