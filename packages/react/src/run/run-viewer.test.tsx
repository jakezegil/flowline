import type { RunDetail, RunEvent } from "@flowkit/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { httpError, mockClient, setupDom } from "../../test/dom";
import { manifest } from "../../test/fixtures";
import { failedLoopRun, runDetail, waitingRun } from "../../test/run-fixtures";
import { FlowkitProvider } from "../provider";
import { RunViewer } from "./run-viewer";

beforeAll(setupDom);
beforeEach(() => localStorage.clear());
afterEach(cleanup);

function setup(initial: RunDetail) {
  let current = initial;
  let listener: ((e: RunEvent) => void) | undefined;
  const client = mockClient({
    getManifest: async () => manifest,
    getRun: async () => current,
    subscribeRun: (_id, onEvent) => {
      listener = onEvent;
      return () => {
        listener = undefined;
      };
    },
  });
  const onRetried = vi.fn();
  render(
    <FlowkitProvider client={client}>
      <div style={{ height: 800 }}>
        <RunViewer runId="r1" onRetried={onRetried} />
      </div>
    </FlowkitProvider>,
  );
  return {
    client,
    onRetried,
    setRun(next: RunDetail) {
      current = next;
    },
    emit(e: RunEvent) {
      listener?.(e);
    },
    subscribed: () => listener !== undefined,
  };
}

const card = (id: string) =>
  document.querySelector<HTMLElement>(`.react-flow__node[data-id="step:${id}"] .fk-card`);

describe("RunViewer", () => {
  test("paints step statuses from the journal on a read-only canvas", async () => {
    setup(failedLoopRun());
    await waitFor(() => expect(card("load")?.dataset.run).toBe("done"));
    expect(card("tag")?.dataset.run).toBe("failed");
    expect(card("nudge")?.dataset.dimmed).toBeDefined();
    // Read-only: no insertion buttons.
    expect(screen.queryByRole("button", { name: "Add step here" })).toBeNull();
    expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
  });

  test("opens on the failed step's error, at the failed iteration", async () => {
    setup(failedLoopRun());
    const inspector = await screen.findByRole("complementary", { name: "Step details" });
    await waitFor(() => expect(within(inspector).getByText("Mailbox full")).toBeTruthy());
    expect(
      within(inspector).getByRole("tab", { name: "Error" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(within(inspector).getByText(/iteration 2 of 3/)).toBeTruthy();
  });

  test("clicking a step shows its output as JSON", async () => {
    setup(failedLoopRun());
    await waitFor(() => expect(card("load")).toBeTruthy());
    fireEvent.click(card("load") as HTMLElement);
    const inspector = screen.getByRole("complementary", { name: "Step details" });
    await waitFor(() =>
      expect(
        within(inspector).getByRole("tab", { name: "Output" }).getAttribute("aria-selected"),
      ).toBe("true"),
    );
    expect(within(inspector).getByText('"Ada"')).toBeTruthy();
    expect(within(inspector).getByText("email")).toBeTruthy();
  });

  test("Retry from failed step starts a retry", async () => {
    const { client, onRetried } = setup(failedLoopRun());
    client.retryRun.mockResolvedValue({ runId: "r2" });
    fireEvent.click(await screen.findByRole("button", { name: "Retry from failed step" }));
    await waitFor(() => expect(onRetried).toHaveBeenCalledWith("r2"));
    expect(client.retryRun).toHaveBeenCalledWith("r1");
  });

  test("a run waiting on a callback can be resumed with a JSON body", async () => {
    const { client } = setup(waitingRun());
    const inspector = await screen.findByRole("complementary", { name: "Step details" });
    await waitFor(() =>
      expect(within(inspector).getByText(/^Waiting for callback · expires/)).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: "Retry from failed step" })).toBeNull();
    client.resumeRun.mockResolvedValue(undefined);
    fireEvent.click(screen.getAllByRole("button", { name: "Resume…" })[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog", { name: "Resume run" });
    const body = within(dialog).getByRole("textbox", { name: "Callback body" });
    fireEvent.change(body, { target: { value: "{ nope" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Resume run" }));
    expect(await within(dialog).findByText("Enter valid JSON")).toBeTruthy();
    fireEvent.change(body, { target: { value: '{"approved": true}' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Resume run" }));
    });
    expect(client.resumeRun).toHaveBeenCalledWith("r1", { approved: true });
  });

  test("Cancel shows Cancelling… until the run is terminal", async () => {
    const t = setup(waitingRun());
    t.client.cancelRun.mockResolvedValue(undefined);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel run" }));
    await screen.findByText("Cancelling…");
    t.setRun(runDetail("cancelled", waitingRun().run.journal));
    act(() => t.emit({ ...waitingRun().events[0], seq: 99, type: "run.cancelled" } as RunEvent));
    await waitFor(() => expect(screen.queryByText("Cancelling…")).toBeNull(), { timeout: 2000 });
    expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
  });

  test("a stopped run reads as stopped", async () => {
    const detail = runDetail("completed", {}, [
      { ...waitingRun().events[0], seq: 5, type: "run.stopped" } as RunEvent,
    ]);
    setup(detail);
    expect(await screen.findByText("Stopped")).toBeTruthy();
  });

  test("shows an error with a retry when the run can't be loaded", async () => {
    const t = setup(failedLoopRun());
    t.client.getRun.mockRejectedValueOnce(httpError(500, { error: "boom" }));
    cleanup();
    render(
      <FlowkitProvider client={t.client}>
        <RunViewer runId="r1" />
      </FlowkitProvider>,
    );
    expect(await screen.findByText("Couldn't load this run.")).toBeTruthy();
  });
});
