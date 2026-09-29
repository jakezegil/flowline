/**
 * Pure document commands used by the editor store, built on `@flowlinejs/core`'s immutable tree
 * operations. Nothing here mutates its inputs.
 *
 * @module
 */

import {
  createStep,
  defaultConfig,
  duplicateStep,
  FlowlineTreeError,
  findStep,
  jsonEqual,
  type NodeManifest,
  type Step,
  syncBranches,
  updateStep,
  type ValueExpr,
  type WorkflowDoc,
} from "@flowlinejs/core";

// Moved to core (`step-factory.ts`); re-exported so existing imports keep working.
export { createStep, defaultConfig, jsonEqual, syncBranches };

/**
 * Changes the type of step `id` to `m`, keeping its ID (so downstream references stay attached)
 * and `disabled` flag; config resets to `m`'s defaults and the name override is dropped.
 *
 * Children never silently change meaning: branches `m` also declares keep their steps, and
 * non-empty branches `m` doesn't declare are kept as undeclared leftovers (the same policy as
 * {@link syncBranches}). The canvas still shows them and the validator flags them
 * (`branch.unknown`), which blocks publishing until the user moves or deletes those steps.
 *
 * @throws {FlowlineTreeError} If `id` doesn't exist.
 */
export function replaceStepType(doc: WorkflowDoc, id: string, m: NodeManifest): WorkflowDoc {
  const found = findStep(doc, id);
  if (!found) throw new FlowlineTreeError(`Step "${id}" not found`);
  const old = found.step;
  const replaced = syncBranches(
    {
      id,
      type: m.type,
      config: defaultConfig(m.input),
      ...(old.disabled ? { disabled: true } : {}),
      ...(old.branches ? { branches: old.branches } : {}),
    },
    m,
  );
  return updateStep(doc, id, () => replaced);
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

/** `config` with `key` set to `value`, or removed when `value` is `undefined`. */
export function withConfigValue(
  config: Record<string, ValueExpr>,
  key: string,
  value: ValueExpr | undefined,
): Record<string, ValueExpr> {
  if (value === undefined) {
    const { [key]: _, ...rest } = config;
    return rest;
  }
  return { ...config, [key]: value };
}
