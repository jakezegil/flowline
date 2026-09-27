/**
 * Pure document commands used by the editor store, built on `@flowkit/core`'s immutable tree
 * operations. Nothing here mutates its inputs.
 *
 * @module
 */

import {
  branchesFor,
  duplicateStep,
  FlowkitTreeError,
  findStep,
  insertStep,
  type JSONSchema,
  type NodeManifest,
  type Step,
  updateStep,
  type ValueExpr,
  type WorkflowDoc,
} from "@flowkit/core";

/**
 * Initial config for a new step or trigger: the `default` of each top-level property of the
 * config's JSON Schema (cloned, so steps never share default objects).
 */
export function defaultConfig(schema: JSONSchema): Record<string, ValueExpr> {
  const config: Record<string, ValueExpr> = {};
  const props = schema.properties;
  if (props === null || typeof props !== "object") return config;
  for (const [key, prop] of Object.entries(props as Record<string, unknown>)) {
    if (prop !== null && typeof prop === "object" && "default" in prop) {
      const value = (prop as { default: unknown }).default;
      if (value !== undefined) config[key] = structuredClone(value) as ValueExpr;
    }
  }
  return config;
}

/**
 * Makes `step.branches` match what its node declares: every declared branch exists (empty if
 * new), and undeclared branches are dropped only when empty, so no step is ever lost (the
 * validator reports leftovers). Returns `step` itself when nothing changes.
 */
export function syncBranches(step: Step, m: NodeManifest): Step {
  const declared = branchesFor(m, step).map((b) => b.id);
  const current = step.branches ?? {};
  const next: Record<string, Step[]> = {};
  for (const id of declared) next[id] = current[id] ?? [];
  for (const [id, list] of Object.entries(current)) {
    if (!(id in next) && list.length > 0) next[id] = list;
  }
  const same =
    Object.keys(next).length === Object.keys(current).length &&
    Object.keys(next).every((id) => current[id] === next[id]);
  if (same) return step;
  if (Object.keys(next).length === 0) {
    const { branches: _, ...rest } = step;
    return rest;
  }
  return { ...step, branches: next };
}

/** A new step of node type `m` with default config and an empty list per declared branch. */
export function createStep(id: string, m: NodeManifest): Step {
  return syncBranches({ id, type: m.type, config: defaultConfig(m.input) }, m);
}

/**
 * Changes the type of step `id` to `m`, keeping its ID (so downstream references stay attached)
 * and `disabled` flag; config resets to `m`'s defaults and the name override is dropped. Children
 * in branches `m` also declares stay put; children of dropped branches move to `m`'s first branch,
 * or, if `m` doesn't branch, right after the step, so nothing is deleted.
 *
 * @throws {FlowkitTreeError} If `id` doesn't exist.
 */
export function replaceStepType(doc: WorkflowDoc, id: string, m: NodeManifest): WorkflowDoc {
  const found = findStep(doc, id);
  if (!found) throw new FlowkitTreeError(`Step "${id}" not found`);
  const old = found.step;
  const fresh = createStep(id, m);
  const kept: Record<string, Step[]> = {};
  const orphans: Step[] = [];
  for (const [branch, list] of Object.entries(old.branches ?? {})) {
    if (fresh.branches && branch in fresh.branches) kept[branch] = list;
    else orphans.push(...list);
  }
  const replaced: Step = { ...fresh, ...(old.disabled ? { disabled: true } : {}) };
  const firstBranch = fresh.branches ? Object.keys(fresh.branches)[0] : undefined;
  if (fresh.branches) {
    replaced.branches = { ...fresh.branches, ...kept };
    if (firstBranch !== undefined && orphans.length > 0) {
      replaced.branches[firstBranch] = [...(replaced.branches[firstBranch] ?? []), ...orphans];
    }
  }
  let next = updateStep(doc, id, () => replaced);
  if (firstBranch === undefined) {
    orphans.forEach((orphan, i) => {
      next = insertStep(next, { ...found.location, index: found.location.index + 1 + i }, orphan);
    });
  }
  return next;
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

/** Whether two JSON values are structurally equal. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
