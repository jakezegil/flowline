import type { RunDetail, RunEvent } from "@flowkit/core";
import type { FlowkitClient } from "@flowkit/core/client";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fixtureDoc, manifest } from "../test/fixtures";
import {
  EditorContext,
  FlowkitClientContext,
  useDataPicker,
  useIssues,
  useRun,
  useSelection,
  useStep,
  useWorkflow,
} from "./hooks";
import { createEditorStore, type EditorStore } from "./store/editor-store";

let store: EditorStore;
const wrapper = ({ children }: { children: ReactNode }) => (
  <EditorContext.Provider value={store}>{children}</EditorContext.Provider>
);

beforeEach(() => {
  localStorage.clear();
  store = createEditorStore({ doc: fixtureDoc(), manifest });
});

describe("editor hooks", () => {
  test("throw a helpful error outside a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useWorkflow())).toThrow(/must be used inside <WorkflowEditor>/);
    vi.restoreAllMocks();
  });

  test("useStep is stable across unrelated changes and updates on its own", () => {
    const { result } = renderHook(() => useStep("email"), { wrapper });
    const first = result.current;
    expect(first).toMatchObject({ step: { id: "email" }, manifest: { type: "crm.sendEmail" } });
    act(() => store.getState().select("load"));
    expect(result.current).toBe(first);
    act(() => store.getState().setSample("email", {}));
    expect(result.current?.testState).toBe("tested");
    act(() => store.getState().removeStep("load"));
    expect(result.current?.issues.map((i) => i.code)).toContain("ref.unresolved");
    act(() => store.getState().removeStep("email"));
    expect(result.current).toBeUndefined();
  });

  test("useStep(B) stays referentially equal when step A is edited", () => {
    const { result } = renderHook(() => useStep("email"), { wrapper });
    const first = result.current;
    act(() => store.getState().setConfig("load", "contactId", "c1"));
    act(() => store.getState().renameStep("load", "Fetch"));
    expect(result.current).toBe(first);
    // Its own issues change identity only when their contents change.
    act(() => store.getState().setConfig("email", "to", undefined));
    const withIssue = result.current;
    expect(withIssue).not.toBe(first);
    expect(withIssue?.issues.map((i) => i.code)).toEqual(["config.required"]);
    act(() => store.getState().setConfig("load", "contactId", "c2"));
    expect(result.current).toBe(withIssue);
  });

  test("useWorkflow, useSelection and useIssues track the store", () => {
    const { result } = renderHook(
      () => ({ wf: useWorkflow(), sel: useSelection(), issues: useIssues() }),
      { wrapper },
    );
    expect(result.current.wf.dirty).toBe(false);
    act(() => result.current.sel[1]("email"));
    expect(result.current.sel[0]).toBe("email");
    act(() => store.getState().removeStep("load"));
    expect(result.current.wf.dirty).toBe(true);
    expect(result.current.issues.errors).toBeGreaterThan(0);
    expect(result.current.issues.byStep.email?.length).toBe(result.current.issues.errors);
  });

  test("useDataPicker lists the trigger and upstream steps", () => {
    const { result } = renderHook(() => useDataPicker("email"), { wrapper });
    expect(result.current.map((e) => e.refBase)).toEqual(["trigger", "steps.load"]);
  });
});

describe("useRun", () => {
  afterEach(() => vi.useRealTimers());

  function fakeClient() {
    let listener: ((e: RunEvent) => void) | undefined;
    const unsubscribe = vi.fn();
    let n = 0;
    const client = {
      getRun: vi.fn(async (id: string) => ({ run: { id, n: ++n } }) as unknown as RunDetail),
      subscribeRun: vi.fn((_id: string, onEvent: (e: RunEvent) => void) => {
        listener = onEvent;
        return unsubscribe;
      }),
    } as unknown as FlowkitClient;
    return { client, unsubscribe, emit: () => listener?.({} as RunEvent) };
  }

  test("loads, refetches (debounced) on events, and unsubscribes on unmount", async () => {
    const { client, unsubscribe, emit } = fakeClient();
    const { result, unmount } = renderHook(() => useRun("r1"), {
      wrapper: ({ children }) => (
        <FlowkitClientContext.Provider value={client}>{children}</FlowkitClientContext.Provider>
      ),
    });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.detail).toBeDefined());
    expect(result.current.loading).toBe(false);
    vi.useFakeTimers();
    emit();
    emit();
    emit();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(client.getRun).toHaveBeenCalledTimes(2);
    expect((result.current.detail!.run as unknown as { n: number }).n).toBe(2);
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  test("keeps the last detail and reports errors of a failed refresh", async () => {
    const { client } = fakeClient();
    const { result } = renderHook(() => useRun("r1"), {
      wrapper: ({ children }) => (
        <FlowkitClientContext.Provider value={client}>{children}</FlowkitClientContext.Provider>
      ),
    });
    await waitFor(() => expect(result.current.detail).toBeDefined());
    vi.mocked(client.getRun).mockRejectedValueOnce(new Error("boom"));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.error?.message).toBe("boom"));
    expect(result.current.detail).toBeDefined();
  });
});
