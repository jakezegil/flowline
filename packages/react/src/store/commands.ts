/**
 * Pure document commands used by the editor store, built on `@flowlinejs/core`'s immutable tree
 * operations. Nothing here mutates its inputs.
 *
 * @module
 */

import {
  type At,
  branchList,
  createStep,
  defaultConfig,
  duplicateStep,
  FlowlineTreeError,
  type Fragment,
  findStep,
  jsonEqual,
  replaceStepType,
  type Step,
  type StepLocation,
  syncBranches,
  type WorkflowDoc,
} from "@flowlinejs/core";

// Moved to core (`step-factory.ts`); re-exported so existing imports keep working.
export { createStep, defaultConfig, jsonEqual, replaceStepType, syncBranches };

/**
 * The command anchor for a StepLocation. A branch position is `in` the branch at its index; a
 * top-level one is `start` at index 0, else `after` the previous sibling. On a doc with duplicate
 * step IDs, where that sibling's ID first names a step elsewhere, the top level anchors `before`
 * the next sibling when that one resolves correctly.
 *
 * @throws {FlowlineTreeError} For a missing parent or branch, or an out-of-range index.
 */
export function atFromLocation(doc: WorkflowDoc, loc: StepLocation): At {
  let list: Step[] | undefined;
  if (loc.parentId === null) {
    list = doc.steps;
  } else {
    const parent = findStep(doc, loc.parentId)?.step;
    list = parent && loc.branch !== undefined ? branchList(parent, loc.branch) : undefined;
  }
  if (!list) {
    throw new FlowlineTreeError(
      `Cannot insert into parent "${loc.parentId ?? "<root>"}" branch "${loc.branch ?? ""}": not found`,
    );
  }
  if (!Number.isInteger(loc.index) || loc.index < 0 || loc.index > list.length) {
    throw new FlowlineTreeError(`Insert index ${loc.index} out of range [0, ${list.length}]`);
  }
  if (loc.parentId !== null) {
    return { in: { stepId: loc.parentId, branch: loc.branch as string }, index: loc.index };
  }
  if (loc.index === 0) return { start: true };
  const prev = list[loc.index - 1] as Step;
  const next = list[loc.index];
  const atTop = (id: string, index: number) => {
    const found = findStep(doc, id)?.location;
    return found?.parentId === null && found.index === index;
  };
  if (next && !atTop(prev.id, loc.index - 1) && atTop(next.id, loc.index)) {
    return { before: next.id };
  }
  return { after: prev.id };
}

/** A step (with subtree) as a verbatim fragment, keeping IDs, config and branches exactly. */
export function stepToFragment(step: Step): Fragment {
  const frag: Fragment = { id: step.id, type: step.type, config: step.config };
  if (step.name !== undefined) frag.name = step.name;
  if (step.disabled !== undefined) frag.disabled = step.disabled;
  if (step.note !== undefined) frag.note = step.note;
  if (step.color !== undefined) frag.color = step.color;
  if (step.branches) {
    const branches: Record<string, Fragment[]> = {};
    for (const [key, list] of Object.entries(step.branches)) {
      // An own property even for `__proto__`, never the prototype.
      Object.defineProperty(branches, key, {
        value: list.map(stepToFragment),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    frag.branches = branches;
  }
  return frag;
}

/**
 * A copy of `step` (with its subtree) whose IDs are all fresh relative to `doc` and to the
 * original, with references between steps inside the copy rewritten to the new IDs. Reuses
 * core's {@link duplicateStep} by duplicating the step inside a scratch doc that also holds all
 * of `doc`'s steps.
 */
export function cloneWithFreshIds(doc: WorkflowDoc, step: Step): Step {
  const scratch: WorkflowDoc = { ...doc, steps: [step, ...doc.steps] };
  // findStep searches pre-order, so `step` (first) is the one duplicated even if `doc` also
  // contains a step with its ID; the copy lands right after it.
  const { doc: withCopy } = duplicateStep(scratch, step.id);
  return withCopy.steps[1] as Step;
}

/** Every step ID in `step`'s subtree, `step` included. */
export function subtreeIds(step: Step): string[] {
  const ids = [step.id];
  for (const list of Object.values(step.branches ?? {})) {
    for (const child of list) ids.push(...subtreeIds(child));
  }
  return ids;
}
