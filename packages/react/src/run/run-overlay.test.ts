import { describe, expect, test } from "vitest";
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
import { buildRunOverlay, resolveRun } from "./run-overlay";

describe("buildRunOverlay", () => {
  test("maps journal entries to statuses with durations and attempts", () => {
    const o = buildRunOverlay(failedLoopRun(), manifest, {});
    expect(o.stepStatus.load).toEqual({ status: "done", durationMs: 182, attempts: 1 });
    expect(o.stepStatus.cond?.status).toBe("done");
    expect(o.stepStatus.email?.status).toBe("done");
    // The loop failed because one of its iterations did.
    expect(o.stepStatus.each?.status).toBe("failed");
    // Disabled steps are skipped even before the run gets to them.
    expect(o.stepStatus.off?.status).toBe("skipped");
  });

  test("marks the taken branch's edges and dims the untaken branch's steps", () => {
    const o = buildRunOverlay(failedLoopRun(), manifest, {});
    expect(o.takenEdges.has("step:cond->step:email")).toBe(true);
    expect(o.takenEdges.has("step:email->join:cond")).toBe(true);
    expect(o.takenEdges.has("step:cond->step:nudge")).toBe(false);
    expect(o.takenEdges.has("step:each->step:tag")).toBe(true);
    expect(o.stepStatus.nudge).toBeUndefined();
    expect(o.dimmedSteps?.has("nudge")).toBe(true);
    expect(o.dimmedSteps?.has("email")).toBe(false);
  });

  test("loops default to the first failed iteration and can show another", () => {
    const detail = failedLoopRun();
    const o = buildRunOverlay(detail, manifest, {});
    expect(o.loopIteration.each).toEqual({
      index: 1,
      count: 3,
      failedIndex: 1,
      failedIndices: [1],
    });
    expect(o.stepStatus.tag).toEqual({ status: "failed", durationMs: 390, attempts: 3 });
    const first = buildRunOverlay(detail, manifest, { each: 0 });
    expect(first.loopIteration.each?.index).toBe(0);
    expect(first.stepStatus.tag).toMatchObject({ status: "done", durationMs: 90 });
    // An iteration that hasn't run yet shows its steps as not run.
    expect(buildRunOverlay(detail, manifest, { each: 2 }).stepStatus.tag?.status).toBe("pending");
    // Out-of-range choices are clamped.
    expect(buildRunOverlay(detail, manifest, { each: 99 }).loopIteration.each?.index).toBe(2);
  });

  test("a finished loop without failures defaults to its last iteration", () => {
    const detail = runDetail("completed", {
      each: {
        status: "done",
        output: { count: 2, results: [{}, {}] },
        startedAt: 0,
        at: 50,
        attempts: 1,
      },
      "each/body[0]/tag": { status: "done", output: {}, startedAt: 1, at: 10, attempts: 1 },
      "each/body[1]/tag": { status: "done", output: {}, startedAt: 11, at: 30, attempts: 1 },
      off: { status: "skipped", at: 60 },
    });
    const o = buildRunOverlay(detail, manifest, {});
    expect(o.loopIteration.each).toMatchObject({ index: 1, count: 2, failedIndices: [] });
    expect(o.stepStatus.tag).toMatchObject({ status: "done", durationMs: 19 });
    expect(o.stepStatus.off?.status).toBe("skipped");
  });

  test("a suspended step is waiting, and so is the block around it", () => {
    const o = buildRunOverlay(waitingRun(), manifest, {});
    expect(o.stepStatus.email?.status).toBe("waiting");
    expect(o.stepStatus.cond?.status).toBe("waiting");
    expect(o.stepStatus.each?.status).toBe("pending");
    expect(o.takenEdges.has("step:cond->step:email")).toBe(true);
  });

  test("a started step without a journal entry is running", () => {
    const detail = runDetail(
      "running",
      { load: { status: "done", output: {}, startedAt: 0, at: 5, attempts: 1 } },
      [
        ev("run.started"),
        ev("step.started", "load"),
        ev("step.completed", "load"),
        ev("step.started", "cond"),
      ],
    );
    const o = buildRunOverlay(detail, manifest, {});
    expect(o.stepStatus.cond?.status).toBe("running");
    // Its branches aren't decided yet: not run yet, and not dimmed.
    expect(o.stepStatus.email?.status).toBe("pending");
    expect(o.dimmedSteps?.size).toBe(0);
  });

  test("a running loop shows its in-flight iteration", () => {
    const done = { status: "done" as const, output: {}, startedAt: 0, at: 5, attempts: 1 };
    const detail = runDetail(
      "running",
      {
        load: done,
        cond: { ...done, branch: "if" },
        "cond/if/email": done,
        each: {
          status: "looping",
          items: [1, 2, 3],
          results: [{}],
          startedAt: 0,
          at: 1,
          attempts: 1,
        },
        "each/body[0]/tag": done,
      },
      [
        ev("step.started", "each/body[0]/tag"),
        ev("step.completed", "each/body[0]/tag"),
        ev("step.started", "each/body[1]/tag"),
      ],
    );
    const o = buildRunOverlay(detail, manifest, {});
    expect(o.loopIteration.each).toMatchObject({ index: 1, count: 3 });
    expect(o.stepStatus.tag?.status).toBe("running");
  });
});

describe("runs that stop or wait inside nested blocks", () => {
  test("a Stop inside two blocks leaves the blocks and the steps before it done", () => {
    const o = buildRunOverlay(approvalStoppedRun(), approvalManifest(), {});
    expect(o.stepStatus.load?.status).toBe("done");
    // Both blocks ran and chose a branch; the Stop inside them ended the run.
    expect(o.stepStatus.size).toEqual({ status: "done", durationMs: 3000, attempts: 1 });
    expect(o.stepStatus.approval).toEqual({ status: "done", durationMs: 2900, attempts: 1 });
    expect(o.stepStatus.halt?.status).toBe("done");
    // What came after the Stop never ran; the untaken branches are dimmed.
    expect(o.stepStatus.after_halt?.status).toBe("pending");
    expect(o.stepStatus.last?.status).toBe("pending");
    expect(o.dimmedSteps?.has("notify")).toBe(true);
    expect(o.dimmedSteps?.has("welcome")).toBe(true);
    expect(o.takenEdges.has("step:approval->step:halt")).toBe(true);
  });

  test("a branching step waiting inside a block: both read as waiting", () => {
    const o = buildRunOverlay(approvalWaitingRun(), approvalManifest(), {});
    expect(o.stepStatus.approval?.status).toBe("waiting");
    expect(o.stepStatus.size?.status).toBe("waiting");
    expect(o.stepStatus.notify?.status).toBe("pending");
    expect(o.stepStatus.last?.status).toBe("pending");
    expect(resolveRun(approvalWaitingRun(), approvalManifest(), {}).focusStepId).toBe("approval");
  });

  test("a cancelled run doesn't mark its unfinished blocks done", () => {
    const detail = { ...approvalWaitingRun() };
    detail.run = { ...detail.run, status: "cancelled" };
    expect(buildRunOverlay(detail, approvalManifest(), {}).stepStatus.size?.status).toBe("pending");
  });
});

describe("resolveRun", () => {
  test("gives each step's journal path at the chosen iteration", () => {
    const { paths } = resolveRun(failedLoopRun(), manifest, { each: 0 });
    expect(paths).toMatchObject({
      load: "load",
      email: "cond/if/email",
      nudge: "cond/else/nudge",
      tag: "each/body[0]/tag",
    });
  });

  test("finds the step that failed the run", () => {
    expect(resolveRun(failedLoopRun(), manifest, {}).focusStepId).toBe("tag");
    expect(resolveRun(waitingRun(), manifest, {}).focusStepId).toBe("email");
  });
});
