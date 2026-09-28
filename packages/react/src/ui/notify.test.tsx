import { findStep } from "@flowkit/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { mockClient, setupDom } from "../../test/dom";
import { fixtureDoc, manifest } from "../../test/fixtures";
import { WorkflowCanvas } from "../canvas/workflow-canvas";
import { type FlowkitNotice, FlowkitProvider, type NotifyHandler } from "../provider";
import { createEditorStore } from "../store/editor-store";
import { ToasterProvider, useToast } from "./toaster";

beforeAll(setupDom);
afterEach(cleanup);

function Notifier() {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast({ message: "Saved as v3", tone: "success" })}>
      Notify
    </button>
  );
}

function renderToaster(onNotify?: NotifyHandler) {
  render(
    <FlowkitProvider client={mockClient()} {...(onNotify ? { onNotify } : {})}>
      <ToasterProvider source="runViewer">
        <Notifier />
      </ToasterProvider>
    </FlowkitProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Notify" }));
}

describe("onNotify", () => {
  test("without it, Flowkit shows its own toast", () => {
    renderToaster();
    expect(screen.getByText("Saved as v3")).toBeTruthy();
  });

  test("routes notices to the host instead of Flowkit's toast", () => {
    const onNotify = vi.fn();
    renderToaster(onNotify);
    expect(onNotify).toHaveBeenCalledWith({
      message: "Saved as v3",
      tone: "success",
      source: "runViewer",
    } satisfies FlowkitNotice);
    expect(screen.queryByText("Saved as v3")).toBeNull();
  });

  test("returning false lets Flowkit show the notice after all", () => {
    const onNotify = vi.fn(() => false as const);
    renderToaster(onNotify);
    expect(onNotify).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Saved as v3")).toBeTruthy();
  });

  test("canvas notices (Step deleted · Undo) go to the host too, with their action", () => {
    const notices: FlowkitNotice[] = [];
    const store = createEditorStore({ doc: fixtureDoc(), manifest });
    render(
      <FlowkitProvider client={mockClient()} onNotify={(n) => void notices.push(n)}>
        <div style={{ height: 600 }}>
          <WorkflowCanvas store={store} />
        </div>
      </FlowkitProvider>,
    );
    act(() => store.getState().select("email"));
    fireEvent.keyDown(document.querySelector(".fk-canvas") as HTMLElement, { key: "Delete" });
    expect(findStep(store.getState().doc, "email")).toBeUndefined();
    expect(screen.queryByText("Deleted “Send email”")).toBeNull();
    expect(notices).toMatchObject([
      { message: "Deleted “Send email”", tone: "neutral", source: "canvas" },
    ]);
    act(() => notices[0]?.action?.run());
    expect(findStep(store.getState().doc, "email")).toBeDefined();
  });
});
