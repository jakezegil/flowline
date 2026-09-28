import type { RunSummary } from "@flowkit/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient, setupDom } from "../../test/dom";
import { FlowkitProvider } from "../provider";
import { RunList } from "./run-list";

const row = (
  id: string,
  status: RunSummary["status"],
  extra: Partial<RunSummary> = {},
): RunSummary => ({
  id,
  workflowId: "welcome",
  version: 3,
  status,
  createdAt: Date.now() - 120_000,
  updatedAt: Date.now() - 118_800,
  startedBy: { kind: "manual" },
  ...extra,
});

beforeEach(setupDom);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RunList", () => {
  it("lists runs with status, time, duration, origin and version", async () => {
    const client = mockClient({
      listRuns: vi.fn(async () => [row("r1", "failed"), row("r2", "completed")]),
    });
    const onSelect = vi.fn();
    render(
      <FlowkitProvider client={client}>
        <RunList workflowId="welcome" selectedRunId="r2" onSelect={onSelect} />
      </FlowkitProvider>,
    );
    const list = await screen.findByRole("list", { name: "Runs" });
    const first = within(list).getByRole("button", { name: /Failed/ });
    expect(first.textContent).toMatch(/2 min(\.|utes)? ago/);
    expect(first.textContent).toContain("1.2s");
    expect(first.textContent).toContain("v3");
    expect(first.textContent).toMatch(/Manual/i);
    expect(
      within(list)
        .getByRole("button", { name: /Completed/ })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(client.listRuns).toHaveBeenCalledWith({ workflowId: "welcome" });
    fireEvent.click(first);
    expect(onSelect).toHaveBeenCalledWith("r1");
  });

  it("filters by status", async () => {
    const client = mockClient({ listRuns: vi.fn(async () => []) });
    render(
      <FlowkitProvider client={client}>
        <RunList onSelect={() => {}} />
      </FlowkitProvider>,
    );
    await screen.findByText(/No runs yet/);
    fireEvent.click(screen.getByRole("button", { name: "Failed" }));
    await waitFor(() => expect(client.listRuns).toHaveBeenLastCalledWith({ status: "failed" }));
    expect(await screen.findByText("No failed runs.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Failed" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("polls every pollMs", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const client = mockClient({ listRuns: vi.fn(async () => [row("r1", "running")]) });
    render(
      <FlowkitProvider client={client}>
        <RunList onSelect={() => {}} pollMs={1000} />
      </FlowkitProvider>,
    );
    await waitFor(() => expect(client.listRuns).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(client.listRuns).toHaveBeenCalledTimes(2);
  });

  it("pauses polling while the page is hidden and reloads when it's shown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const client = mockClient({ listRuns: vi.fn(async () => [row("r1", "running")]) });
    render(
      <FlowkitProvider client={client}>
        <RunList onSelect={() => {}} pollMs={1000} />
      </FlowkitProvider>,
    );
    await waitFor(() => expect(client.listRuns).toHaveBeenCalledTimes(1));
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(client.listRuns).toHaveBeenCalledTimes(1);
      hidden.mockReturnValue(false);
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(client.listRuns).toHaveBeenCalledTimes(2);
    } finally {
      hidden.mockRestore();
    }
  });

  it("shows a retryable error", async () => {
    const listRuns = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue([row("r1", "waiting")]);
    render(
      <FlowkitProvider client={mockClient({ listRuns })}>
        <RunList onSelect={() => {}} />
      </FlowkitProvider>,
    );
    expect(await screen.findByText("Couldn't load runs.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      within(await screen.findByRole("list", { name: "Runs" })).getByRole("button", {
        name: /Waiting/,
      }),
    ).toBeTruthy();
  });
});
