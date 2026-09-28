/**
 * Turns a run's journal into what the canvas paints: a status per step, the edges the run took and
 * the iteration shown per loop. Pure, so the run viewer can recompute it on every refetch.
 *
 * Journal paths (from the engine): a top-level step is `"<id>"`, a step in a branch
 * `"<blockPath>/<branch>/<id>"`, and a step in loop iteration `i` `"<loopPath>/body[<i>]/<id>"`.
 *
 * @module
 */

import type { JournalEntry, Manifest, NodeManifest, RunDetail, Step } from "@flowkit/core";
import type { RunOverlay, RunStepStatus } from "../canvas/canvas-context";
import { layoutTree } from "../layout/layout-tree";

/** A run resolved against its doc for one choice of loop iterations. */
export interface ResolvedRun {
  /** What the canvas paints. */
  overlay: RunOverlay;
  /** Journal path of every step at the chosen iterations (also for steps that never ran). */
  paths: Record<string, string>;
  /**
   * The step worth opening first: the one that failed the run, else the one it's waiting on.
   * `undefined` when neither applies.
   */
  focusStepId?: string;
}

type Reach = "taken" | "untaken" | "later";

const ACTIVE = new Set(["queued", "running", "waiting"]);
const ITERATION = /\/body\[(\d+)\]\//;

/**
 * Builds the {@link RunOverlay} of a run: statuses from the journal (for steps inside loops, at the
 * iteration chosen in `iteration`, by default the first failed iteration, else the last one
 * reached), taken edges from the branches the run chose, and untaken branches dimmed.
 *
 * @param iteration Iteration index to show per loop step ID; out-of-range values are clamped.
 *
 * @example
 * const overlay = buildRunOverlay(detail, manifest, { eachTag: 2 });
 * <WorkflowCanvas store={store} readOnly overlay={overlay} />
 */
export function buildRunOverlay(
  detail: RunDetail,
  manifest: Manifest,
  iteration: Record<string, number>,
): RunOverlay {
  return resolveRun(detail, manifest, iteration).overlay;
}

/**
 * Like {@link buildRunOverlay}, also returning each step's journal path and the step to focus.
 * @internal
 */
export function resolveRun(
  detail: RunDetail,
  manifest: Manifest,
  iteration: Record<string, number>,
): ResolvedRun {
  const { run, doc, events } = detail;
  const journal = run.journal;
  const runActive = ACTIVE.has(run.status);
  const nodes = new Map<string, NodeManifest>(manifest.nodes.map((n) => [n.type, n]));
  const layout = layoutTree(doc, manifest);
  const entryAt = (path: string): JournalEntry | undefined =>
    Object.hasOwn(journal, path) ? journal[path] : undefined;

  // Steps that started (or are retrying) and haven't finished: running now.
  const inFlight = new Set<string>();
  for (const e of events) {
    if (!e.stepPath) continue;
    if (e.type === "step.started" || e.type === "step.retrying") inFlight.add(e.stepPath);
    else if (e.type.startsWith("step.")) inFlight.delete(e.stepPath);
  }

  const paths: Record<string, string> = {};
  const stepStatus: Record<string, RunStepStatus> = {};
  const takenEdges = new Set<string>();
  const dimmedSteps = new Set<string>();
  const loopIteration: RunOverlay["loopIteration"] = {};
  const keys = Object.keys(journal);

  /** The worst state among journal entries under `prefix` (a block's descendants). */
  function descendantState(prefix: string): "failed" | "waiting" | undefined {
    let waiting = false;
    for (const k of keys) {
      if (!k.startsWith(prefix)) continue;
      const s = journal[k]?.status;
      if (s === "failed") return "failed";
      if (s === "suspended") waiting = true;
    }
    return waiting ? "waiting" : undefined;
  }

  /** The latest `at` among journal entries under `prefix`, at least `from`. */
  function latestAt(prefix: string, from: number): number {
    let latest = from;
    for (const k of keys) {
      const at = k.startsWith(prefix) ? journal[k]?.at : undefined;
      if (at !== undefined && at > latest) latest = at;
    }
    return latest;
  }

  function takeBranch(blockId: string, branch: string) {
    for (const e of layout.edges) {
      if (e.kind === "branch" && e.source === `step:${blockId}` && e.branchId === branch) {
        takenEdges.add(e.id);
      } else if (
        e.kind === "join" &&
        e.target === `join:${blockId}` &&
        (e.loc?.branch === branch || e.source === `ph:${blockId}:${branch}`)
      ) {
        takenEdges.add(e.id);
      }
    }
  }

  function statusOf(step: Step, path: string, e: JournalEntry | undefined): RunStepStatus {
    if (!e) {
      if (runActive && inFlight.has(path)) return { status: "running" };
      return { status: step.disabled ? "skipped" : "pending" };
    }
    switch (e.status) {
      case "done":
        return { status: "done", durationMs: e.at - e.startedAt, attempts: e.attempts };
      case "failed":
        // A failed entry of a live run is waiting for its next attempt.
        return runActive
          ? { status: "running", attempts: e.attempts }
          : { status: "failed", durationMs: e.at - e.startedAt, attempts: e.attempts };
      case "suspended":
        return { status: "waiting", attempts: e.attempts };
      case "skipped":
        return { status: "skipped" };
      default: {
        // A block (branched or looping) whose children haven't all finished.
        const worst = descendantState(`${path}/`);
        if (worst === "failed" && !runActive) return { status: "failed", attempts: e.attempts };
        if (worst === "waiting" && run.status === "waiting") {
          return { status: "waiting", attempts: e.attempts };
        }
        if (runActive) return { status: "running", attempts: e.attempts };
        // A completed run left it unfinished: a Stop step inside it ended the run. The block
        // itself ran (it chose its branch), so it is done, up to its last journaled child.
        if (run.status === "completed") {
          return {
            status: "done",
            durationMs: latestAt(`${path}/`, e.at) - e.startedAt,
            attempts: e.attempts,
          };
        }
        return { status: "pending", attempts: e.attempts };
      }
    }
  }

  function loopInfo(step: Step, path: string, e: JournalEntry | undefined) {
    let count = 0;
    if (e?.status === "looping") count = e.items.length;
    else if (e?.status === "done") {
      const out = e.output as { count?: unknown } | null | undefined;
      if (typeof out?.count === "number") count = out.count;
    }
    const failed = new Set<number>();
    let lastReached = -1;
    const prefix = `${path}/body[`;
    // Iterations with a journal entry, plus (while the run is live) the one in flight.
    for (const k of runActive ? [...keys, ...inFlight] : keys) {
      if (!k.startsWith(prefix)) continue;
      const m = ITERATION.exec(k.slice(path.length));
      if (!m) continue;
      const i = Number(m[1]);
      lastReached = Math.max(lastReached, i);
      if (journal[k]?.status === "failed") failed.add(i);
    }
    count = Math.max(count, lastReached + 1);
    const failedIndices = [...failed].sort((a, b) => a - b);
    const fallback = failedIndices[0] ?? (lastReached >= 0 ? lastReached : count - 1);
    const chosen = iteration[step.id] ?? fallback;
    const index = Math.max(0, Math.min(Math.max(count - 1, 0), chosen));
    return {
      index,
      count,
      ...(failedIndices[0] !== undefined ? { failedIndex: failedIndices[0] } : {}),
      failedIndices,
    };
  }

  /**
   * `reach`: `"taken"` for columns the run entered, `"untaken"` for branches it decided against
   * (dimmed), `"later"` for columns of blocks it hasn't decided yet (not run yet).
   */
  function visit(steps: Step[], prefix: string, reach: Reach): void {
    for (const step of steps) {
      const path = prefix + step.id;
      paths[step.id] = path;
      const m = nodes.get(step.type);
      const e = reach === "taken" ? entryAt(path) : undefined;
      if (reach === "untaken") dimmedSteps.add(step.id);
      else stepStatus[step.id] = statusOf(step, path, e);

      if (m?.branches.kind === "loop") {
        const info = loopInfo(step, path, e);
        if (reach === "taken") loopIteration[step.id] = info;
        const decided = e !== undefined && e.status !== "failed";
        const bodyReach: Reach =
          reach !== "taken" ? reach : !decided ? "later" : info.count > 0 ? "taken" : "untaken";
        for (const key of Object.keys(step.branches ?? {})) {
          const r: Reach = key === m.branches.branch ? bodyReach : "untaken";
          if (r === "taken") takeBranch(step.id, key);
          visit(step.branches?.[key] ?? [], `${path}/body[${info.index}]/`, r);
        }
        continue;
      }
      const taken = e && "branch" in e ? e.branch : undefined;
      if (taken !== undefined) takeBranch(step.id, taken);
      for (const [key, list] of Object.entries(step.branches ?? {})) {
        let r: Reach = reach;
        if (reach === "taken")
          r = taken === undefined ? "later" : key === taken ? "taken" : "untaken";
        visit(list, `${path}/${key}/`, r);
      }
    }
  }

  visit(doc.steps, "", "taken");

  const byPath = new Map(Object.entries(paths).map(([id, p]) => [p, id]));
  const idAt = (path: string | undefined) => {
    if (path === undefined) return undefined;
    // Paths of other iterations map to the step by stripping iteration indexes.
    return byPath.get(path) ?? stepIdOfPath(path);
  };
  let focusStepId: string | undefined;
  if (run.status === "failed") {
    focusStepId =
      idAt(run.error?.stepPath) ??
      idAt(keys.find((k) => journal[k]?.status === "failed" && !isBlock(k)));
  } else if (run.status === "waiting") {
    focusStepId = idAt(keys.find((k) => journal[k]?.status === "suspended"));
  }

  const overlay: RunOverlay = { stepStatus, takenEdges, loopIteration, dimmedSteps };
  return { overlay, paths, ...(focusStepId !== undefined ? { focusStepId } : {}) };

  function isBlock(path: string): boolean {
    return keys.some((k) => k.startsWith(`${path}/`));
  }
}

/** The step ID a journal path ends in (`"each/body[2]/tag"` → `"tag"`). */
export function stepIdOfPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}
