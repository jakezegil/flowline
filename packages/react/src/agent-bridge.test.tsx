import { findStep } from "@flowlinejs/core";
import { cleanup, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { setupDom } from "../test/dom";
import { fixtureDoc, manifest } from "../test/fixtures";
import { createAgentBridge, useWorkflowAgentBridge } from "./agent-bridge";
import { WorkflowCanvas } from "./canvas/workflow-canvas";
import { EditorContext } from "./hooks";
import { createEditorStore, type EditorStore } from "./store/editor-store";

beforeAll(setupDom);
beforeEach(() => localStorage.clear());
afterEach(cleanup);

const storeFor = (readOnly = false): EditorStore =>
  createEditorStore({ doc: fixtureDoc(), manifest, readOnly });

describe("createAgentBridge", () => {
  test("read.overview reflects the doc after a store change, with no re-render", () => {
    const store = storeFor();
    const bridge = createAgentBridge(store);
    expect(bridge.read.overview({}).text).toContain("email");
    store.getState().renameStep("email", "Welcome mail");
    expect(bridge.read.overview({}).text).toContain("Welcome mail");
    expect(bridge.read.focus({ stepId: "email" }).name).toBe("Welcome mail");
  });

  test("apply changes the doc, flashes the changed steps and adds one undo step", () => {
    const store = storeFor();
    const bridge = createAgentBridge(store);
    const r = bridge.apply([
      { op: "renameStep", id: "load", name: "Get contact" },
      { op: "setConfig", id: "email", key: "subject", value: "Hello" },
    ]);
    expect(r.ok).toBe(true);
    expect(findStep(store.getState().doc, "load")?.step.name).toBe("Get contact");
    expect(store.getState().flash?.ids).toEqual(["load", "email"]);
    expect(store.getState().canUndo).toBe(true);
    store.getState().undo();
    expect(store.getState().canUndo).toBe(false);
    expect(findStep(store.getState().doc, "load")?.step.name).toBeUndefined();
  });

  test('runTool("apply") goes through store.apply and returns the result without the doc', () => {
    const store = storeFor();
    const bridge = createAgentBridge(store);
    const r = bridge.runTool("apply", {
      commands: [{ op: "renameStep", id: "load", name: "Get contact" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc).toBe(store.getState().doc);
    expect(r.result).toMatchObject({ ok: true });
    expect(r.result).not.toHaveProperty("doc");
    expect(store.getState().canUndo).toBe(true);
    expect(store.getState().flash?.ids).toEqual(["load"]);
  });

  test('runTool("apply") on a read-only store gives readOnly and changes nothing', () => {
    const store = storeFor(true);
    const before = store.getState().doc;
    const r = createAgentBridge(store).runTool("apply", {
      commands: [{ op: "removeStep", id: "load" }],
    });
    expect(r).toMatchObject({ ok: true, result: { ok: false, error: { code: "readOnly" } } });
    expect(store.getState().doc).toBe(before);
  });

  test('runTool("apply") keeps the catalog\'s strict envelope and public schema', () => {
    const store = storeFor();
    const bridge = createAgentBridge(store);
    expect(bridge.runTool("apply", { commands: [], extra: 1 })).toMatchObject({
      ok: false,
      error: { code: "command.invalid", path: "extra" },
    });
    const verbatim = bridge.runTool("apply", {
      commands: [
        { op: "insertSteps", at: { start: true }, verbatim: true, steps: [{ type: "x.y" }] },
      ],
    });
    expect(verbatim).toMatchObject({ ok: true, result: { ok: false } });
    // Untrusted: an unknown placeholder is rejected.
    const placeholder = bridge.runTool("apply", {
      commands: [{ op: "setConfig", id: "email", key: "to", value: { $ref: "steps.$9.email" } }],
    });
    expect(placeholder).toMatchObject({ ok: true, result: { ok: false } });
    expect(store.getState().canUndo).toBe(false);
  });

  test('runTool("overview") returns the live outline; unknown tools fail', () => {
    const store = storeFor();
    const bridge = createAgentBridge(store);
    store.getState().renameWorkflow("Onboarding");
    const r = bridge.runTool("overview", {});
    expect(r.ok && (r.result as { text: string }).text).toContain("Onboarding");
    expect(bridge.runTool("nope", {})).toMatchObject({
      ok: false,
      error: { code: "tool.unknown" },
    });
  });
});

describe("useWorkflowAgentBridge", () => {
  test("defaults to the enclosing editor's store and is memoized per store", () => {
    const store = storeFor();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <EditorContext.Provider value={store}>{children}</EditorContext.Provider>
    );
    const { result, rerender } = renderHook(() => useWorkflowAgentBridge(), { wrapper });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    first.apply([{ op: "renameStep", id: "load", name: "X" }]);
    expect(findStep(store.getState().doc, "load")?.step.name).toBe("X");
    const other = storeFor();
    const { result: explicit } = renderHook(() => useWorkflowAgentBridge(other), { wrapper });
    explicit.current.apply([{ op: "renameStep", id: "load", name: "Y" }]);
    expect(findStep(other.getState().doc, "load")?.step.name).toBe("Y");
  });
});

describe("read-only source of truth", () => {
  test("<WorkflowCanvas readOnly> sets the store flag and restores it on unmount", () => {
    const store = storeFor();
    const { unmount } = render(<WorkflowCanvas store={store} readOnly />);
    expect(store.getState().readOnly).toBe(true);
    expect(createAgentBridge(store).apply([{ op: "removeStep", id: "load" }])).toMatchObject({
      ok: false,
      error: { code: "readOnly" },
    });
    unmount();
    expect(store.getState().readOnly).toBe(false);
  });

  test("a read-only store keeps the canvas read-only without the prop", () => {
    const store = storeFor(true);
    render(<WorkflowCanvas store={store} />);
    expect(document.querySelector(".fl-canvas")?.hasAttribute("data-readonly")).toBe(true);
    expect(document.querySelectorAll(".fl-edge-ctl")).toHaveLength(0);
  });
});
