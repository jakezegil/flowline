import type { WorkflowDetail, WorkflowDoc } from "@flowlinejs/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mockClient, setupDom } from "../../test/dom";
import { fixtureDoc, manifest } from "../../test/fixtures";
import { createAgentBridge } from "../agent-bridge";
import { WorkflowCanvas } from "../canvas/workflow-canvas";
import { ConfigPanel } from "../panel/config-panel";
import { FlowlineProvider } from "../provider";
import { createEditorStore, type EditorStore, TRIGGER_KEY } from "../store/editor-store";
import { WorkflowEditor } from "./workflow-editor";

/**
 * Ruling 29: once the store is read-only (a host's `setReadOnly`, `<WorkflowCanvas readOnly>`),
 * no control calls a doc action that would throw; and the step picker never inserts at a
 * location the doc has moved out from under it.
 */

beforeAll(setupDom);
beforeEach(() => localStorage.clear());
afterEach(cleanup);

function detail(doc: WorkflowDoc): WorkflowDetail {
  const v = { workflowId: doc.id, tenantId: "t", version: 1, doc, createdBy: "u", createdAt: 0 };
  return { latest: v, published: null };
}

const ids = (store: EditorStore) => store.getState().doc.steps.map((s) => s.id);

describe("read-only editor controls", () => {
  test("header undo/redo and the name field don't edit (or throw) once read-only", async () => {
    const client = mockClient({
      getManifest: async () => manifest,
      listSubflows: async () => [],
      getWorkflow: async () => detail(fixtureDoc()),
    });
    let store: EditorStore | undefined;
    render(
      <FlowlineProvider client={client}>
        <div style={{ height: 800 }}>
          <WorkflowEditor
            workflowId="welcome"
            onStoreReady={(s) => {
              store = s;
            }}
          />
        </div>
      </FlowlineProvider>,
    );
    const name = (await screen.findByRole("textbox", {
      name: "Workflow name",
    })) as HTMLInputElement;
    const s = store as EditorStore;
    act(() => s.getState().renameStep("email", "Mail"));
    expect(s.getState().canUndo).toBe(true);
    act(() => s.getState().setReadOnly(true));

    const undo = screen.getByRole("button", { name: "Undo" });
    const redo = screen.getByRole("button", { name: "Redo" });
    expect(undo.getAttribute("aria-disabled")).toBe("true");
    expect(redo.getAttribute("aria-disabled")).toBe("true");
    expect(() => fireEvent.click(undo)).not.toThrow();
    expect(() => fireEvent.click(redo)).not.toThrow();
    expect(s.getState().doc.steps[1]?.name).toBe("Mail");

    expect(name.readOnly).toBe(true);
    fireEvent.focus(name);
    fireEvent.change(name, { target: { value: "Renamed" } });
    expect(() => fireEvent.blur(name)).not.toThrow();
    expect(() => fireEvent.keyDown(name, { key: "Enter" })).not.toThrow();
    expect(s.getState().doc.name).toBe("Welcome");
  });

  test("the config panel's inputs are read-only and never call setConfig or rename", () => {
    const store = createEditorStore({ doc: fixtureDoc(), manifest, readOnly: true });
    store.getState().select("email");
    render(
      <FlowlineProvider client={mockClient()}>
        <ConfigPanel store={store} />
      </FlowlineProvider>,
    );
    // The name is shown, not a rename button.
    expect(screen.queryByRole("button", { name: /Rename step/ })).toBeNull();
    const heading = screen.getByRole("heading", { name: /Send email/ });
    expect(within(heading).queryByRole("button")).toBeNull();
    // Selects and checkboxes are disabled; text editors are read-only.
    for (const el of Array.from(
      document.querySelectorAll<HTMLSelectElement | HTMLInputElement>(
        ".fl-cp select, .fl-cp input",
      ),
    )) {
      expect(el.disabled || (el as HTMLInputElement).readOnly).toBe(true);
    }
    for (const cm of Array.from(document.querySelectorAll(".fl-cp .cm-content"))) {
      expect(cm.getAttribute("contenteditable")).toBe("false");
    }
    const before = store.getState().doc;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(".fl-cp select"))) {
      expect(() => fireEvent.change(el, { target: { value: "text" } })).not.toThrow();
    }
    expect(store.getState().doc).toBe(before);
  });

  test("the trigger panel is read-only too", () => {
    const store = createEditorStore({ doc: fixtureDoc(), manifest, readOnly: true });
    store.getState().select(TRIGGER_KEY);
    render(
      <FlowlineProvider client={mockClient()}>
        <ConfigPanel store={store} />
      </FlowlineProvider>,
    );
    const type = screen.getByRole("combobox", { name: "Trigger type" }) as HTMLSelectElement;
    expect(type.disabled).toBe(true);
    const before = store.getState().doc;
    expect(() => fireEvent.change(type, { target: { value: "logic.manual" } })).not.toThrow();
    expect(store.getState().doc).toBe(before);
  });

  test("the delete toast's Undo is gone once read-only, and never throws", async () => {
    const store = createEditorStore({ doc: fixtureDoc(), manifest });
    render(<WorkflowCanvas store={store} />);
    const card = document.querySelector<HTMLElement>('.react-flow__node[data-id="step:email"]');
    card?.focus();
    fireEvent.keyDown(card as HTMLElement, { key: "Delete" });
    const undo = await screen.findByRole("button", { name: "Undo" });
    act(() => store.getState().setReadOnly(true));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(() => fireEvent.click(undo)).not.toThrow();
    expect(ids(store)).toEqual(["load"]);
  });
});

describe("the step picker and outside edits", () => {
  async function openPickerAfterLoad(store: EditorStore) {
    render(<WorkflowCanvas store={store} />);
    fireEvent.click(screen.getByRole("button", { name: "Add step after Load contact" }));
    return screen.findByRole("dialog", { name: "Add step" });
  }

  test("an agent edit while the picker is open closes it; nothing is inserted", async () => {
    const store = createEditorStore({ doc: fixtureDoc(), manifest });
    await openPickerAfterLoad(store);
    act(() => {
      const r = createAgentBridge(store).apply([
        { op: "addStep", at: { start: true }, type: "crm.loadContact" },
      ]);
      expect(r.ok).toBe(true);
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add step" })).toBeNull());
    const after = ids(store);
    expect(after).toHaveLength(3);
    expect(after.slice(1)).toEqual(["load", "email"]);
  });

  test("an edit that changes nothing keeps it open, and picking inserts where it was opened", async () => {
    const store = createEditorStore({ doc: fixtureDoc(), manifest });
    const picker = await openPickerAfterLoad(store);
    act(() => {
      createAgentBridge(store).apply([
        { op: "setConfig", id: "load", key: "contactId", value: { $ref: "trigger.contactId" } },
      ]);
      store.getState().apply([]);
    });
    expect(screen.getByRole("dialog", { name: "Add step" })).toBe(picker);
    fireEvent.click(within(picker).getByText("Condition"));
    const steps = store.getState().doc.steps;
    expect(steps[0]?.id).toBe("load");
    expect(steps[1]?.type).toBe("logic.condition");
    expect(steps[2]?.id).toBe("email");
  });

  test("going read-only while the picker is open closes it without throwing", async () => {
    const store = createEditorStore({ doc: fixtureDoc(), manifest });
    await openPickerAfterLoad(store);
    act(() => store.getState().setReadOnly(true));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add step" })).toBeNull());
    expect(ids(store)).toEqual(["load", "email"]);
  });
});
