import type { Manifest, RunDetail, RunEvent } from "@flowkit/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { httpError, mockClient, setupDom } from "../../test/dom";
import { manifest } from "../../test/fixtures";
import {
  approvalManifest,
  approvalStoppedRun,
  approvalWaitingRun,
  ev,
  failedLoopRun,
  runDetail,
  waitingRun,
} from "../../test/run-fixtures";
import { FlowkitProvider } from "../provider";
import { RunList } from "./run-list";
import { RunViewer } from "./run-viewer";

beforeAll(setupDom);
beforeEach(() => localStorage.clear());
afterEach(cleanup);

function setup(
  initial: RunDetail,
  opts: {
    manifest?: Manifest;
    props?: Partial<ComponentProps<typeof RunViewer>>;
  } = {},
) {
  let current = initial;
  let listener: ((e: RunEvent) => void) | undefined;
  const client = mockClient({
    getManifest: async () => opts.manifest ?? manifest,
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
        <RunViewer runId="r1" onRetried={onRetried} {...opts.props} />
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

  test("after retrying in place it listens to the run again", async () => {
    const t = setup(failedLoopRun());
    await waitFor(() => expect(card("tag")?.dataset.run).toBe("failed"));
    // A finished run is not listened to.
    await waitFor(() => expect(t.subscribed()).toBe(false));
    // The engine retries under the same run id.
    t.client.retryRun.mockImplementation(async () => {
      t.setRun({ ...failedLoopRun(), run: { ...failedLoopRun().run, status: "queued" } });
      return { runId: "r1" };
    });
    fireEvent.click(await screen.findByRole("button", { name: "Retry from failed step" }));
    await waitFor(() => expect(t.onRetried).toHaveBeenCalledWith("r1"));
    await waitFor(() => expect(t.subscribed()).toBe(true));
    // Live events refetch the run again.
    t.setRun(runDetail("completed", failedLoopRun().run.journal));
    act(() => t.emit({ ...failedLoopRun().events[0], seq: 99, type: "run.completed" } as RunEvent));
    await waitFor(() => expect(screen.getAllByText("Completed").length).toBeGreaterThan(0));
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
    // Resumes only the wait it was opened for.
    expect(client.resumeRun).toHaveBeenCalledWith(
      "r1",
      { approved: true },
      { expectStep: "cond/if/email" },
    );
  });

  test("Cancel shows Cancelling… until the run is terminal", async () => {
    const t = setup(waitingRun());
    t.client.cancelRun.mockResolvedValue(undefined);
    // Cancelling asks first; "Keep running" backs out.
    fireEvent.click(await screen.findByRole("button", { name: "Cancel run" }));
    const confirm = await screen.findByRole("dialog", { name: "Cancel this run?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep running" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Cancel this run?" })).toBeNull(),
    );
    expect(t.client.cancelRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    const again = await screen.findByRole("dialog", { name: "Cancel this run?" });
    fireEvent.click(within(again).getByRole("button", { name: "Cancel run" }));
    await screen.findByText("Cancelling…");
    expect(t.client.cancelRun).toHaveBeenCalledWith("r1");
    t.setRun(runDetail("cancelled", waitingRun().run.journal));
    act(() => t.emit({ ...waitingRun().events[0], seq: 99, type: "run.cancelled" } as RunEvent));
    await waitFor(() => expect(screen.queryByText("Cancelling…")).toBeNull(), { timeout: 2000 });
    expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
  });

  test("a run that fails while open selects its failed step", async () => {
    const t = setup(runDetail("running", {}, []));
    await waitFor(() => expect(card("load")).toBeTruthy());
    expect(screen.queryByRole("complementary", { name: "Step details" })).toBeNull();
    t.setRun(failedLoopRun());
    act(() => t.emit({ ...failedLoopRun().events[0], seq: 99, type: "run.failed" } as RunEvent));
    const panel = await screen.findByRole(
      "complementary",
      { name: "Step details" },
      { timeout: 2000 },
    );
    expect(within(panel).getAllByText("Mailbox full").length).toBeGreaterThan(0);
  });

  test("Try again after a manifest failure reloads it", async () => {
    const t = setup(failedLoopRun());
    cleanup();
    t.client.getManifest.mockRejectedValueOnce(new Error("offline"));
    render(
      <FlowkitProvider client={t.client}>
        <RunViewer runId="r1" />
      </FlowkitProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(card("load")).toBeTruthy());
  });

  test("a stopped run reads as stopped, from its stoppedAt (not its events)", async () => {
    setup(runDetail("completed", {}, [], { stoppedAt: "halt" }));
    expect(await screen.findByText("Stopped")).toBeTruthy();
    cleanup();
    // A run.stopped event alone (e.g. a trimmed or partial event list) doesn't decide it.
    setup(
      runDetail("completed", {}, [
        { ...waitingRun().events[0], seq: 5, type: "run.stopped" } as RunEvent,
      ]),
    );
    expect(await screen.findByText("Completed")).toBeTruthy();
  });

  test("a run that doesn't exist shows Run not found with the host's action, not Try again", async () => {
    const t = setup(failedLoopRun());
    t.client.getRun.mockRejectedValue(httpError(404, { error: "Run not found" }));
    cleanup();
    const back = vi.fn();
    const { unmount } = render(
      <FlowkitProvider client={t.client}>
        <RunViewer runId="nope" notFoundAction={{ label: "Back to runs", onClick: back }} />
      </FlowkitProvider>,
    );
    expect(await screen.findByText("Run not found")).toBeTruthy();
    expect(screen.getByText(/There is no run with the ID “nope”/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to runs" }));
    expect(back).toHaveBeenCalled();
    unmount();
    // Without an action: just the message.
    render(
      <FlowkitProvider client={t.client}>
        <RunViewer runId="nope" />
      </FlowkitProvider>,
    );
    expect(await screen.findByText("Run not found")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
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

describe("RunViewer: stopping inside branches", () => {
  test("a run a Stop ended inside two blocks shows them and the steps before as done", async () => {
    setup(approvalStoppedRun(), { manifest: approvalManifest() });
    await waitFor(() => expect(card("halt")?.dataset.run).toBe("stopped"));
    expect(
      within(card("halt") as HTMLElement).getAllByText("Stopped the run").length,
    ).toBeGreaterThan(0);
    expect(card("size")?.dataset.run).toBe("done");
    expect(card("approval")?.dataset.run).toBe("done");
    expect(card("load")?.dataset.run).toBe("done");
    expect(card("after_halt")?.dataset.run).toBe("skipped");
    expect(screen.getByText("Stopped")).toBeTruthy();
  });

  test("a stopped run has a banner naming the Stop step and its reason, and opens it", async () => {
    setup(approvalStoppedRun(), { manifest: approvalManifest() });
    const banner = (await screen.findByText(/^Stopped at /)).closest(".fk-banner") as HTMLElement;
    expect(banner.dataset.tone).toBe("neutral");
    expect(within(banner).getByText("No")).toBeTruthy();
    // The Stop step is opened, like a failed or waiting step.
    const inspector = await screen.findByRole("complementary", { name: "Step details" });
    await waitFor(() =>
      expect(within(inspector).getAllByText("Stopped the run").length).toBeGreaterThan(0),
    );
    expect(within(banner).getByRole("button", { name: "Show step" })).toBeTruthy();
  });

  test("a run cancelled while waiting shows the wait as Cancelled", async () => {
    const detail = approvalWaitingRun();
    detail.run = { ...detail.run, status: "cancelled" };
    setup(detail, { manifest: approvalManifest() });
    await waitFor(() => expect(card("approval")?.dataset.run).toBe("cancelled"));
    expect(card("size")?.dataset.run).toBe("done");
    expect(screen.queryByRole("button", { name: "Resume…" })).toBeNull();
  });

  test("a block with a waiting child reads as done; the child waits", async () => {
    setup(approvalWaitingRun(), { manifest: approvalManifest() });
    await waitFor(() => expect(card("approval")?.dataset.run).toBe("waiting"));
    expect(card("size")?.dataset.run).toBe("done");
  });
});

describe("RunViewer: resuming", () => {
  const resumeButtons = () => screen.queryAllByRole("button", { name: "Resume…" });
  const waitForInspector = async () => {
    const inspector = await screen.findByRole("complementary", { name: "Step details" });
    await waitFor(() =>
      expect(within(inspector).getAllByText(/^Waiting for callback/).length).toBeGreaterThan(0),
    );
    return inspector;
  };

  test("resumeAction={false} hides Resume… in the header and the inspector", async () => {
    setup(waitingRun(), { props: { resumeAction: false } });
    await waitForInspector();
    expect(resumeButtons()).toHaveLength(0);
    // Cancel stays available.
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeTruthy();
  });

  test("a resumeAction function renders the host's control in both places", async () => {
    const resumeAction = vi.fn(({ placement, stepId, stepPath }) => (
      <a href={`/approvals?step=${stepPath}`}>{`Decide ${stepId} (${placement})`}</a>
    ));
    setup(waitingRun(), { props: { resumeAction } });
    const inspector = await waitForInspector();
    expect(await screen.findByRole("link", { name: "Decide email (header)" })).toBeTruthy();
    expect(within(inspector).getByRole("link", { name: "Decide email (inspector)" })).toBeTruthy();
    expect(resumeButtons()).toHaveLength(0);
    expect(resumeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        stepId: "email",
        stepPath: "cond/if/email",
        node: expect.anything(),
      }),
    );
  });

  test("a host-handled wait shows the node's guidance instead of Resume…", async () => {
    setup(approvalWaitingRun(), {
      manifest: approvalManifest({ hostHandled: true, hint: "Decide it in Approvals." }),
    });
    const inspector = await screen.findByRole("complementary", { name: "Step details" });
    await waitFor(() =>
      expect(within(inspector).getByText("Decide it in Approvals.")).toBeTruthy(),
    );
    expect(
      screen.getByText(/Waiting for a decision · expires .*\. Decide it in Approvals\./),
    ).toBeTruthy();
    expect(resumeButtons()).toHaveLength(0);
  });

  test("a declared body schema: the form starts empty, and a body must match it", async () => {
    const t = setup(approvalWaitingRun(), {
      manifest: approvalManifest({
        body: {
          type: "object",
          properties: { decision: { type: "string", enum: ["approved", "rejected"] } },
          required: ["decision"],
        },
      }),
    });
    t.client.resumeRun.mockResolvedValue(undefined);
    await waitFor(() => expect(resumeButtons().length).toBeGreaterThan(0));
    fireEvent.click(resumeButtons()[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog", { name: "Resume run" });
    const body = within(dialog).getByRole("textbox", {
      name: "Callback body",
    }) as HTMLTextAreaElement;
    // No `{}` to send by accident; the placeholder shows the expected shape.
    expect(body.value).toBe("");
    expect(JSON.parse(body.placeholder)).toEqual({ decision: "approved" });
    expect(within(dialog).getByText("Expects { decision }")).toBeTruthy();
    const submit = within(dialog).getByRole("button", { name: "Resume run" });
    fireEvent.click(submit);
    expect(await within(dialog).findByText("Enter the callback body")).toBeTruthy();
    fireEvent.change(body, { target: { value: "{}" } });
    fireEvent.click(submit);
    expect(await within(dialog).findByText('"decision" is required')).toBeTruthy();
    fireEvent.change(body, { target: { value: '{"decision": "maybe"}' } });
    fireEvent.click(submit);
    expect(
      await within(dialog).findByText('"decision" must be one of: "approved", "rejected"'),
    ).toBeTruthy();
    expect(t.client.resumeRun).not.toHaveBeenCalled();
    fireEvent.change(body, { target: { value: '{"decision": "approved"}' } });
    await act(async () => {
      fireEvent.click(submit);
    });
    expect(t.client.resumeRun).toHaveBeenCalledWith(
      "r1",
      { decision: "approved" },
      { expectStep: "size/if/approval" },
    );
  });
});

describe("RunViewer: cancelled runs", () => {
  function cancelledWhileWaiting(data?: unknown): RunDetail {
    const detail = approvalWaitingRun();
    const at = Date.now() - 3 * 60_000;
    return {
      ...detail,
      run: { ...detail.run, status: "cancelled", updatedAt: at },
      events: [...detail.events, ev("run.cancelled", "size/if/approval", data, at)],
    };
  }

  test("has a banner saying where it was waiting, who cancelled it and when", async () => {
    setup(cancelledWhileWaiting({ by: "u_ava" }), {
      manifest: approvalManifest(),
      props: { userName: (id) => (id === "u_ava" ? "Ava Chen" : undefined) },
    });
    const title = await screen.findByText("Cancelled while waiting at Request approval");
    const banner = title.closest(".fk-banner") as HTMLElement;
    expect(banner.dataset.tone).toBe("neutral");
    expect(within(banner).getByText(/^By Ava Chen · 3 min(\.|utes)? ago$/)).toBeTruthy();
    fireEvent.click(within(banner).getByRole("button", { name: "Show step" }));
    const inspector = await screen.findByRole("complementary", { name: "Step details" });
    expect(within(inspector).getByRole("heading", { name: "Request approval" })).toBeTruthy();
    // Nothing after the cancelled wait will run: those steps read Skipped, not "Not run yet".
    expect(card("last")?.dataset.run).toBe("skipped");
  });

  test("shows the reason, and the user ID when there is no name for it", async () => {
    setup(cancelledWhileWaiting({ by: "demo-user", reason: "Demo data reset" }), {
      manifest: approvalManifest(),
    });
    expect(await screen.findByText(/^By demo-user · Demo data reset · /)).toBeTruthy();
  });

  test("without a step or actor it still says the run was cancelled, and when", async () => {
    const detail = runDetail("cancelled", {}, [ev("run.started"), ev("run.cancelled")]);
    setup(detail);
    const banner = (await screen.findByText(/^Cancelled$/, { selector: ".fk-banner__title" }))
      .parentElement as HTMLElement;
    expect(within(banner).getByText(/ago|just now/)).toBeTruthy();
  });

  test("cancelling updates a RunList of the same provider without waiting for its poll", async () => {
    let current = waitingRun();
    const summary = () => {
      const { trigger: _t, journal: _j, output: _o, wakeAt: _w, parent: _p, ...s } = current.run;
      return s;
    };
    const client = mockClient({
      getManifest: async () => manifest,
      getRun: async () => current,
      listRuns: vi.fn(async () => [summary()]),
      cancelRun: vi.fn(async () => {
        current = runDetail("cancelled", waitingRun().run.journal, [
          ...waitingRun().events,
          ev("run.cancelled", "cond/if/email", { by: "u1" }),
        ]);
      }),
    });
    render(
      <FlowkitProvider client={client}>
        <RunList onSelect={() => {}} pollMs={0} />
        <div style={{ height: 800 }}>
          <RunViewer runId="r1" />
        </div>
      </FlowkitProvider>,
    );
    const list = await screen.findByRole("list", { name: "Runs" });
    expect(within(list).getByRole("button", { name: /Waiting/ })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel run" }));
    const confirm = await screen.findByRole("dialog", { name: "Cancel this run?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel run" }));
    await waitFor(() =>
      expect(within(list).getByRole("button", { name: /Cancelled/ })).toBeTruthy(),
    );
    expect(await screen.findByText(/^Cancelled while waiting at /)).toBeTruthy();
  });
});

describe("RunViewer: timed waits", () => {
  test("a wait ending in a few seconds says when, not 'just now'", async () => {
    const until = Date.now() + 30_000;
    const detail = runDetail(
      "waiting",
      {
        load: { status: "done", output: {}, startedAt: 0, at: 5, attempts: 1 },
        cond: {
          status: "branched",
          branch: "if",
          output: {},
          startedAt: 6,
          at: 7,
          attempts: 1,
        },
        "cond/if/email": {
          status: "suspended",
          pending: { until },
          startedAt: 8,
          at: 9,
          attempts: 1,
        },
      },
      [ev("run.started"), ev("run.suspended", "cond/if/email", { until })],
    );
    setup(detail);
    const inspector = await screen.findByRole("complementary", { name: "Step details" });
    const callout = await within(inspector).findByText(/^Waiting until /, {
      selector: ".fk-callout__text",
    });
    expect(callout.textContent).toMatch(/ · in a few seconds$/);
    expect(callout.textContent).not.toMatch(/just now/);
  });
});

describe("RunViewer: tablet widths", () => {
  test("keeps the inspector beside the canvas from 561px to 720px and the zoom controls clear of the sheet", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
    const i = css.indexOf("@container fk-app (min-width: 561px) and (max-width: 720px)");
    expect(i).toBeGreaterThan(-1);
    const block = css.slice(i, css.indexOf("@container", i + 10));
    expect(block).toMatch(/\.fk-run \.fk-editor__body \{\s*flex-direction: row;/);
    expect(block).toMatch(/\.fk-run \.fk-panel \{[^}]*width: 300px;[^}]*height: auto;/);
    expect(css).toMatch(
      /\.fk-editor__body:has\(> \.fk-panel\) \.fk-controls\.react-flow__panel \{\s*margin-bottom: 30px;/,
    );
  });
});
