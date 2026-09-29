import type { RunSummary } from "@flowlinejs/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient, setupDom } from "../../test/dom";
import { FlowlineProvider } from "../provider";
import { publishRunChange } from "./run-changes";
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
      <FlowlineProvider client={client}>
        <RunList workflowId="welcome" selectedRunId="r2" onSelect={onSelect} />
      </FlowlineProvider>,
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

  it("renders a poll run's origin with labels.originPoll(itemKey)", async () => {
    const client = mockClient({
      listRuns: vi.fn(async () => [
        row("r1", "completed", {
          startedBy: { kind: "poll", since: 0, until: 1, itemKey: "deal_123" },
        }),
      ]),
    });
    render(
      <FlowlineProvider client={client}>
        <RunList workflowId="welcome" onSelect={() => {}} />
      </FlowlineProvider>,
    );
    const list = await screen.findByRole("list", { name: "Runs" });
    const row1 = within(list).getByRole("button", { name: /Completed/ });
    expect(row1.textContent).toContain("Polled (item deal_123)");
  });

  it("Ruling 102: a host overriding only originPoll sees it in the rendered origin", async () => {
    const client = mockClient({
      listRuns: vi.fn(async () => [
        row("r1", "completed", {
          startedBy: { kind: "poll", since: 0, until: 1, itemKey: "deal_123" },
        }),
      ]),
    });
    render(
      <FlowlineProvider client={client} labels={{ originPoll: (k) => `X ${k}` }}>
        <RunList workflowId="welcome" onSelect={() => {}} />
      </FlowlineProvider>,
    );
    const list = await screen.findByRole("list", { name: "Runs" });
    const row1 = within(list).getByRole("button", { name: /Completed/ });
    expect(row1.textContent).toContain("X deal_123");
  });

  it("filters by status", async () => {
    const client = mockClient({ listRuns: vi.fn(async () => []) });
    render(
      <FlowlineProvider client={client}>
        <RunList onSelect={() => {}} />
      </FlowlineProvider>,
    );
    await screen.findByText(/No runs yet/);
    fireEvent.click(screen.getByRole("button", { name: "Failed" }));
    await waitFor(() =>
      expect(client.listRuns).toHaveBeenLastCalledWith({ status: "failed", topLevel: true }),
    );
    expect(await screen.findByText("No failed runs.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Failed" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("polls every pollMs", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const client = mockClient({ listRuns: vi.fn(async () => [row("r1", "running")]) });
    render(
      <FlowlineProvider client={client}>
        <RunList onSelect={() => {}} pollMs={1000} />
      </FlowlineProvider>,
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
      <FlowlineProvider client={client}>
        <RunList onSelect={() => {}} pollMs={1000} />
      </FlowlineProvider>,
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

  it("reads a run a Stop step ended as Stopped", async () => {
    const client = mockClient({
      listRuns: vi.fn(async () => [
        row("r1", "completed", { stoppedAt: "size/if/halt" }),
        row("r2", "completed"),
      ]),
    });
    render(
      <FlowlineProvider client={client}>
        <RunList workflowId="welcome" onSelect={() => {}} />
      </FlowlineProvider>,
    );
    const list = await screen.findByRole("list", { name: "Runs" });
    const [stopped, completed] = within(list).getAllByRole("button");
    expect(stopped?.querySelector(".fl-runs__status")?.textContent).toBe("Stopped");
    expect(stopped?.dataset.status).toBe("stopped");
    expect(completed?.querySelector(".fl-runs__status")?.textContent).toBe("Completed");
  });

  it("across workflows, leaves out sub-flow runs and names each run's workflow", async () => {
    const client = mockClient({
      listRuns: vi.fn(async () => [
        row("r1", "completed", { workflowId: "lead-routing" }),
        row("r2", "failed", { workflowId: "gone" }),
      ]),
      listWorkflows: vi.fn(async () => [
        {
          id: "lead-routing",
          name: "Inbound lead routing",
          triggerType: "core.webhook",
          latestVersion: 1,
          publishedVersion: 1,
          publishedAt: 0,
          updatedAt: 0,
        },
      ]),
    });
    render(
      <FlowlineProvider client={client}>
        <RunList onSelect={() => {}} />
      </FlowlineProvider>,
    );
    const list = await screen.findByRole("list", { name: "Runs" });
    expect(client.listRuns).toHaveBeenCalledWith({ topLevel: true });
    await waitFor(() =>
      expect(within(list).getByRole("button", { name: /Completed/ }).textContent).toContain(
        "Inbound lead routing · ",
      ),
    );
    // An ID the list doesn't know stays as it is, and doesn't reload the names.
    expect(within(list).getByRole("button", { name: /Failed/ }).textContent).toContain("gone · ");
    expect(client.listWorkflows).toHaveBeenCalledTimes(1);
  });

  it("includeSubflowRuns lists sub-flow runs too; one workflow's list includes them by default", async () => {
    const client = mockClient({ listRuns: vi.fn(async () => []) });
    const { rerender } = render(
      <FlowlineProvider client={client}>
        <RunList onSelect={() => {}} includeSubflowRuns />
      </FlowlineProvider>,
    );
    await waitFor(() => expect(client.listRuns).toHaveBeenLastCalledWith({}));
    rerender(
      <FlowlineProvider client={client}>
        <RunList onSelect={() => {}} workflowId="get-contact" />
      </FlowlineProvider>,
    );
    await waitFor(() =>
      expect(client.listRuns).toHaveBeenLastCalledWith({ workflowId: "get-contact" }),
    );
    rerender(
      <FlowlineProvider client={client}>
        <RunList onSelect={() => {}} workflowId="get-contact" includeSubflowRuns={false} />
      </FlowlineProvider>,
    );
    await waitFor(() =>
      expect(client.listRuns).toHaveBeenLastCalledWith({
        workflowId: "get-contact",
        topLevel: true,
      }),
    );
  });

  it("shows a retryable error", async () => {
    const listRuns = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue([row("r1", "waiting")]);
    render(
      <FlowlineProvider client={mockClient({ listRuns })}>
        <RunList onSelect={() => {}} />
      </FlowlineProvider>,
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

describe("RunList: stopped runs and narrow widths", () => {
  it("has a Stopped filter, and Completed leaves stopped runs out", async () => {
    const client = mockClient({ listRuns: vi.fn(async () => []) });
    render(
      <FlowlineProvider client={client}>
        <RunList onSelect={() => {}} />
      </FlowlineProvider>,
    );
    await screen.findByText(/No runs yet/);
    fireEvent.click(screen.getByRole("button", { name: "Stopped" }));
    await waitFor(() =>
      expect(client.listRuns).toHaveBeenLastCalledWith({
        status: "completed",
        stopped: true,
        topLevel: true,
      }),
    );
    expect(await screen.findByText("No stopped runs.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Completed" }));
    await waitFor(() =>
      expect(client.listRuns).toHaveBeenLastCalledWith({
        status: "completed",
        stopped: false,
        topLevel: true,
      }),
    );
  });

  it("wraps the filter chips instead of clipping them", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
    const rule = /\.fl-runs__filters \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/flex-wrap: wrap/);
    expect(rule).not.toMatch(/overflow-x/);
  });
});

describe("RunList: staying current", () => {
  it("reloads when the window regains focus", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const listRuns = vi.fn(async () => [row("r1", "running")]);
    render(
      <FlowlineProvider client={mockClient({ listRuns })}>
        <RunList onSelect={() => {}} pollMs={0} />
      </FlowlineProvider>,
    );
    await screen.findByRole("list", { name: "Runs" });
    expect(listRuns).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    fireEvent.focus(window);
    await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(2));
  });

  it("loads once when coming back to the tab fires both visibilitychange and focus", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const listRuns = vi.fn(async () => [row("r1", "running")]);
    render(
      <FlowlineProvider client={mockClient({ listRuns })}>
        <RunList onSelect={() => {}} pollMs={0} />
      </FlowlineProvider>,
    );
    await screen.findByRole("list", { name: "Runs" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      fireEvent.focus(window);
    });
    expect(listRuns).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    fireEvent.focus(window);
    expect(listRuns).toHaveBeenCalledTimes(3);
  });

  it("updates a row at once when a viewer of the same client sees the run change", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const waiting = row("r1", "waiting");
    const listRuns = vi
      .fn()
      .mockResolvedValueOnce([waiting])
      .mockResolvedValue([{ ...waiting, status: "cancelled" }]);
    const client = mockClient({ listRuns });
    render(
      <FlowlineProvider client={client}>
        <RunList onSelect={() => {}} pollMs={0} />
      </FlowlineProvider>,
    );
    const list = await screen.findByRole("list", { name: "Runs" });
    expect(within(list).getByRole("button", { name: /Waiting/ })).toBeTruthy();
    // What useRun (and so RunViewer) publishes after loading the run, e.g. once it was cancelled.
    act(() => publishRunChange(client, { ...waiting, status: "cancelled" }));
    expect(within(list).getByRole("button", { name: /Cancelled/ })).toBeTruthy();
    // CHANGE_RELOAD_MS in run-list.tsx debounces the reload after a run-change publish.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(listRuns).toHaveBeenCalledTimes(2);
  });

  it("drops a run that no longer matches the filter", async () => {
    const waiting = row("r1", "waiting");
    const listRuns = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([waiting])
      .mockResolvedValue([]);
    const client = mockClient({ listRuns });
    render(
      <FlowlineProvider client={client}>
        <RunList onSelect={() => {}} pollMs={0} />
      </FlowlineProvider>,
    );
    await screen.findByText(/No runs yet/);
    fireEvent.click(screen.getByRole("button", { name: "Waiting" }));
    const list = await screen.findByRole("list", { name: "Runs" });
    expect(within(list).getByRole("button", { name: /Waiting/ })).toBeTruthy();
    act(() => publishRunChange(client, { ...waiting, status: "cancelled" }));
    expect(await screen.findByText("No waiting runs.")).toBeTruthy();
  });

  it("names what each run is about with describeRun", async () => {
    const client = mockClient({
      listRuns: vi.fn(async () => [row("r1", "waiting"), row("r2", "waiting")]),
    });
    render(
      <FlowlineProvider client={client}>
        <RunList
          onSelect={() => {}}
          describeRun={(r) => (r.id === "r1" ? "ada@example.com" : undefined)}
        />
      </FlowlineProvider>,
    );
    const list = await screen.findByRole("list", { name: "Runs" });
    expect(within(list).getByRole("button", { name: /ada@example\.com/ })).toBeTruthy();
    expect(within(list).getAllByRole("button")).toHaveLength(2);
  });
});
