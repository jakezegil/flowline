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

  it("reads a run a Stop step ended as Stopped", async () => {
    const client = mockClient({
      listRuns: vi.fn(async () => [
        row("r1", "completed", { stoppedAt: "size/if/halt" }),
        row("r2", "completed"),
      ]),
    });
    render(
      <FlowkitProvider client={client}>
        <RunList workflowId="welcome" onSelect={() => {}} />
      </FlowkitProvider>,
    );
    const list = await screen.findByRole("list", { name: "Runs" });
    const [stopped, completed] = within(list).getAllByRole("button");
    expect(stopped?.querySelector(".fk-runs__status")?.textContent).toBe("Stopped");
    expect(stopped?.dataset.status).toBe("stopped");
    expect(completed?.querySelector(".fk-runs__status")?.textContent).toBe("Completed");
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
      <FlowkitProvider client={client}>
        <RunList onSelect={() => {}} />
      </FlowkitProvider>,
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
      <FlowkitProvider client={client}>
        <RunList onSelect={() => {}} includeSubflowRuns />
      </FlowkitProvider>,
    );
    await waitFor(() => expect(client.listRuns).toHaveBeenLastCalledWith({}));
    rerender(
      <FlowkitProvider client={client}>
        <RunList onSelect={() => {}} workflowId="get-contact" />
      </FlowkitProvider>,
    );
    await waitFor(() =>
      expect(client.listRuns).toHaveBeenLastCalledWith({ workflowId: "get-contact" }),
    );
    rerender(
      <FlowkitProvider client={client}>
        <RunList onSelect={() => {}} workflowId="get-contact" includeSubflowRuns={false} />
      </FlowkitProvider>,
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

describe("RunList: stopped runs and narrow widths", () => {
  it("has a Stopped filter, and Completed leaves stopped runs out", async () => {
    const client = mockClient({ listRuns: vi.fn(async () => []) });
    render(
      <FlowkitProvider client={client}>
        <RunList onSelect={() => {}} />
      </FlowkitProvider>,
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

  it("keeps the filter chips on one row that scrolls sideways", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
    const rule = /\.fk-runs__filters \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/flex-wrap: nowrap/);
    expect(rule).toMatch(/overflow-x: auto/);
    expect(css).toMatch(
      /\.fk-runs__filters\[data-overflow\] \{[^}]*mask-image: var\(--fk-runs-fade\)/,
    );
    for (const edge of ["start", "end", "both"]) {
      expect(css).toContain(`.fk-runs__filters[data-overflow="${edge}"] {\n    --fk-runs-fade:`);
    }
  });

  it("marks which ends of the chip row have more chips past them", async () => {
    render(
      <FlowkitProvider client={mockClient({ listRuns: async () => [] })}>
        <RunList onSelect={() => {}} />
      </FlowkitProvider>,
    );
    const row = screen.getByRole("group", { name: "Filter runs by status" });
    await screen.findByText(/No runs yet/);
    // Everything fits (jsdom's default: no layout).
    expect(row.hasAttribute("data-overflow")).toBe(false);
    const size = { scrollLeft: 0, clientWidth: 320, scrollWidth: 520 };
    for (const key of Object.keys(size) as (keyof typeof size)[]) {
      Object.defineProperty(row, key, { configurable: true, get: () => size[key] });
    }
    const scrollTo = (left: number) => {
      size.scrollLeft = left;
      fireEvent.scroll(row);
    };
    scrollTo(0);
    expect(row.getAttribute("data-overflow")).toBe("end");
    scrollTo(100);
    expect(row.getAttribute("data-overflow")).toBe("both");
    scrollTo(200);
    expect(row.getAttribute("data-overflow")).toBe("start");
    size.scrollWidth = 320;
    scrollTo(0);
    expect(row.hasAttribute("data-overflow")).toBe(false);
  });
});
