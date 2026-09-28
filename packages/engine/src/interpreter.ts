/**
 * The pure workflow interpreter: given a document and a run's journal, decide what happens next
 * and what a step can see. No I/O, no clock.
 *
 * Step paths: a top-level step is `"<stepId>"`; a step inside a branch is
 * `"<blockPath>/<branchId>/<stepId>"`; a step inside loop iteration `i` is
 * `"<loopPath>/body[<i>]/<stepId>"`.
 *
 * @module
 */
import type { JournalEntry, Registry, ResolveScope, Step, WorkflowDoc } from "@flowlinejs/core";

/** One enclosing block of a step: a branch block, or a loop iteration (with its item). */
export type Frame = {
  /** Path of the enclosing branch or loop step. */
  blockPath: string;
  /** For loop iterations: the current item and its index. */
  loop?: { item: unknown; index: number };
};

/** What the executor must do next for a run. */
export type NextAction =
  /** Run the step's handler (no entry yet, suspended, or failed and being retried). */
  | { type: "exec"; step: Step; path: string; scopeFrames: Frame[] }
  /** Record a disabled step as skipped. */
  | { type: "skip"; step: Step; path: string }
  /** All children of a branched or looping step have finished: mark the block done. */
  | { type: "completeBlock"; step: Step; path: string }
  /** Every top-level step is finished: complete the run. */
  | { type: "complete" };

/** @internal Own-property journal lookup, so keys like `constructor` never hit the prototype. */
export function entryAt(
  journal: Record<string, JournalEntry>,
  path: string,
): JournalEntry | undefined {
  return Object.hasOwn(journal, path) ? journal[path] : undefined;
}

/** @internal The child step list `key` of `step`, own properties only (empty if missing). */
export function childSteps(step: Step, key: string): Step[] {
  const branches = step.branches;
  if (!branches || !Object.hasOwn(branches, key)) return [];
  const list = branches[key];
  return Array.isArray(list) ? list : [];
}

/**
 * Decide the next action for a run by walking the document against its journal: the first step
 * (in document order, descending into taken branches and loop iterations) that is not finished.
 *
 * @param doc The run's pinned workflow document.
 * @param journal The run's journal, keyed by step path.
 * @param _registry The node registry (reserved; the walk needs only the journal).
 */
export function nextAction(
  doc: WorkflowDoc,
  journal: Record<string, JournalEntry>,
  _registry: Registry,
): NextAction {
  function walk(steps: Step[], prefix: string, frames: Frame[]): NextAction | null {
    for (const step of steps) {
      const path = prefix + step.id;
      const e = entryAt(journal, path);
      if (step.disabled) {
        if (!e) return { type: "skip", step, path };
        continue;
      }
      if (e?.status === "done" || e?.status === "skipped") continue;
      if (e?.status === "branched") {
        const r = walk(childSteps(step, e.branch), `${path}/${e.branch}/`, [
          ...frames,
          { blockPath: path },
        ]);
        if (r) return r;
        return { type: "completeBlock", step, path };
      }
      if (e?.status === "looping") {
        for (let i = 0; i < e.items.length; i++) {
          const r = walk(childSteps(step, "body"), `${path}/body[${i}]/`, [
            ...frames,
            { blockPath: path, loop: { item: e.items[i], index: i } },
          ]);
          if (r) return r;
        }
        return { type: "completeBlock", step, path };
      }
      return { type: "exec", step, path, scopeFrames: frames };
    }
    return null;
  }
  return walk(doc.steps, "", []) ?? { type: "complete" };
}

const LOOP_SEGMENT = /^body\[(\d+)\]\//;

/**
 * The values visible to the step at `path` (see core's `availableScope` for the same rule at
 * design time): outputs of earlier siblings at every level, the outputs of enclosing branch
 * blocks, and the innermost loop's `item`/`index` (a loop's own output only exists after it).
 * A finished step with an `undefined` output is visible as `{}`; skipped steps are absent.
 *
 * Pass a path that names no step (e.g. `""`) to get the end-of-run scope: every top-level step.
 *
 * @param doc The run's pinned workflow document.
 * @param journal The run's journal.
 * @param path Path of the step whose scope to build.
 * @param trigger The run's trigger payload.
 * @param runId The run's ID.
 */
export function buildScope(
  doc: WorkflowDoc,
  journal: Record<string, JournalEntry>,
  path: string,
  trigger: unknown,
  runId: string,
): ResolveScope {
  // Null prototype: a ref such as `steps.constructor` must resolve to undefined.
  const steps: Record<string, unknown> = Object.create(null);
  let loop: { item: unknown; index: number } | undefined;

  const expose = (step: Step, stepPath: string) => {
    const e = entryAt(journal, stepPath);
    if (e?.status === "done" || e?.status === "branched") {
      steps[step.id] = e.output === undefined ? {} : e.output;
    }
  };

  let list = doc.steps;
  let prefix = "";
  for (;;) {
    const rest = path.slice(prefix.length);
    const target = list.find((s) => rest === s.id || rest.startsWith(`${s.id}/`));
    for (const s of list) {
      if (s === target) break;
      expose(s, prefix + s.id);
    }
    if (!target || rest === target.id) break;

    const blockPath = prefix + target.id;
    const inner = rest.slice(target.id.length + 1);
    const entry = entryAt(journal, blockPath);
    const loopMatch = entry?.status === "looping" ? LOOP_SEGMENT.exec(inner) : null;
    if (entry?.status === "looping" && loopMatch) {
      const index = Number(loopMatch[1]);
      loop = { item: entry.items[index], index };
      list = childSteps(target, "body");
      prefix = `${blockPath}/${loopMatch[0]}`;
      continue;
    }
    const taken = entry && "branch" in entry ? entry.branch : undefined;
    const key =
      taken !== undefined && inner.startsWith(`${taken}/`)
        ? taken
        : Object.keys(target.branches ?? {}).find((k) => inner.startsWith(`${k}/`));
    if (key === undefined) break;
    expose(target, blockPath);
    list = childSteps(target, key);
    prefix = `${blockPath}/${key}/`;
  }

  return { trigger, steps, ...(loop ? { loop } : {}), run: { id: runId } };
}
