import { isValidStepId, RESERVED_STEP_IDS } from "./ids";
import { formatRefPath, isRef, isTpl, parseRefPath, parseTemplate } from "./refs";
import type { Step, ValueExpr, WorkflowDoc } from "./types";

/** Thrown when a tree operation targets a step, branch, or index that doesn't exist. */
export class FlowkitTreeError extends Error {
  /** Error name, for `instanceof`-free checks across package copies. */
  override readonly name = "FlowkitTreeError";
}

/** Where a step sits in the tree: which list it's in, and its position within it. */
export interface StepLocation {
  /** The owning step's ID, or `null` for the workflow's top-level step list. */
  parentId: string | null;
  /** The branch key within the parent's `branches`. Unused (and omitted) for the top level. */
  branch?: string;
  /** Position within that list. */
  index: number;
}

/** The result of {@link findStep}: a step, its location, and the chain of steps enclosing it. */
export interface FoundStep {
  /** The matched step. */
  step: Step;
  /** Where it sits in the tree. */
  location: StepLocation;
  /** Enclosing steps, outermost first, with the branch each descends into. */
  ancestors: { step: Step; branch: string }[];
}

/** Finds a step by ID anywhere in the tree, or `undefined` if no step has that ID. */
export function findStep(doc: WorkflowDoc, id: string): FoundStep | undefined {
  function search(
    steps: Step[],
    parentId: string | null,
    branch: string | undefined,
    ancestors: { step: Step; branch: string }[],
  ): FoundStep | undefined {
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index] as Step;
      if (step.id === id) {
        return { step, location: { parentId, branch, index }, ancestors };
      }
      if (step.branches) {
        for (const [branchKey, branchSteps] of Object.entries(step.branches)) {
          const found = search(branchSteps, step.id, branchKey, [
            ...ancestors,
            { step, branch: branchKey },
          ]);
          if (found) return found;
        }
      }
    }
    return undefined;
  }
  return search(doc.steps, null, undefined, []);
}

/** Visits every step in the tree, pre-order (a step before its branch children). */
export function walkSteps(
  doc: WorkflowDoc,
  fn: (step: Step, loc: StepLocation, depth: number) => void,
): void {
  function walk(
    steps: Step[],
    parentId: string | null,
    branch: string | undefined,
    depth: number,
  ): void {
    steps.forEach((step, index) => {
      fn(step, { parentId, branch, index }, depth);
      if (step.branches) {
        for (const [branchKey, branchSteps] of Object.entries(step.branches)) {
          walk(branchSteps, step.id, branchKey, depth + 1);
        }
      }
    });
  }
  walk(doc.steps, null, undefined, 0);
}

/** Collects every step ID present anywhere in the doc. */
export function allStepIds(doc: WorkflowDoc): Set<string> {
  const ids = new Set<string>();
  walkSteps(doc, (step) => ids.add(step.id));
  return ids;
}

/** Reads the step list at a location, or `undefined` if the parent/branch doesn't exist. */
function getList(
  doc: WorkflowDoc,
  parentId: string | null,
  branch: string | undefined,
): Step[] | undefined {
  if (parentId === null) return doc.steps;
  const found = findStep(doc, parentId);
  if (!found || branch === undefined) return undefined;
  return found.step.branches?.[branch];
}

/**
 * Rebuilds `doc` with the step list at `(parentId, branch)` replaced by `newList`. Path-copying:
 * only the steps and lists on the path from the root to that list are copied; every other step
 * and branch list keeps its identity, so consumers can skip unchanged subtrees by reference.
 * The parent is the first pre-order match, like {@link findStep}.
 */
function replaceList(
  doc: WorkflowDoc,
  parentId: string | null,
  branch: string | undefined,
  newList: Step[],
): WorkflowDoc {
  if (parentId === null) {
    return { ...doc, steps: newList };
  }
  /** `steps` with the parent's list replaced, or `undefined` if the parent isn't under it. */
  function recur(steps: Step[]): Step[] | undefined {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] as Step;
      let replaced: Step | undefined;
      if (step.id === parentId) {
        replaced = { ...step, branches: { ...step.branches, [branch as string]: newList } };
      } else if (step.branches) {
        for (const [branchKey, branchSteps] of Object.entries(step.branches)) {
          const list = recur(branchSteps);
          if (list) {
            replaced = { ...step, branches: { ...step.branches, [branchKey]: list } };
            break;
          }
        }
      }
      if (replaced) {
        const copy = steps.slice();
        copy[i] = replaced;
        return copy;
      }
    }
    return undefined;
  }
  const steps = recur(doc.steps);
  return steps ? { ...doc, steps } : doc;
}

/**
 * Inserts `step` at `loc`, immutably. Throws {@link FlowkitTreeError} if the location's parent or
 * branch doesn't exist, the index is out of `[0, length]` range, or `step.id` is already used.
 */
export function insertStep(doc: WorkflowDoc, loc: StepLocation, step: Step): WorkflowDoc {
  if (allStepIds(doc).has(step.id)) {
    throw new FlowkitTreeError(`Step id "${step.id}" already exists in the workflow`);
  }
  const list = getList(doc, loc.parentId, loc.branch);
  if (!list) {
    throw new FlowkitTreeError(
      `Cannot insert into parent "${loc.parentId ?? "<root>"}" branch "${loc.branch ?? ""}": not found`,
    );
  }
  if (loc.index < 0 || loc.index > list.length) {
    throw new FlowkitTreeError(`Insert index ${loc.index} out of range [0, ${list.length}]`);
  }
  const newList = [...list.slice(0, loc.index), step, ...list.slice(loc.index)];
  return replaceList(doc, loc.parentId, loc.branch, newList);
}

/** Removes the step with `id`, immutably. Throws {@link FlowkitTreeError} if not found. */
export function removeStep(doc: WorkflowDoc, id: string): WorkflowDoc {
  const found = findStep(doc, id);
  if (!found) throw new FlowkitTreeError(`Step "${id}" not found`);
  const list = getList(doc, found.location.parentId, found.location.branch);
  if (!list) throw new FlowkitTreeError(`Step "${id}" not found`);
  const newList = list.filter((_, i) => i !== found.location.index);
  return replaceList(doc, found.location.parentId, found.location.branch, newList);
}

/**
 * Moves the step with `id` to location `to`, immutably. `to.index` is interpreted against the
 * destination list *after* the step has been removed from its original location.
 *
 * @throws {FlowkitTreeError} If `id` doesn't exist, or `to` names a parent within the moved
 *   step's own subtree (including the step itself).
 */
export function moveStep(doc: WorkflowDoc, id: string, to: StepLocation): WorkflowDoc {
  const found = findStep(doc, id);
  if (!found) throw new FlowkitTreeError(`Step "${id}" not found`);
  const removed = removeStep(doc, id);
  return insertStep(removed, to, found.step);
}

/** Replaces the step with `id` with `fn(step)`, immutably. Throws if `id` doesn't exist. */
export function updateStep(doc: WorkflowDoc, id: string, fn: (s: Step) => Step): WorkflowDoc {
  const found = findStep(doc, id);
  if (!found) throw new FlowkitTreeError(`Step "${id}" not found`);
  const newStep = fn(found.step);
  if (newStep.id !== id && allStepIds(doc).has(newStep.id)) {
    throw new FlowkitTreeError(`Step id "${newStep.id}" already exists in the workflow`);
  }
  const list = getList(doc, found.location.parentId, found.location.branch);
  if (!list) throw new FlowkitTreeError(`Step "${id}" not found`);
  const newList = list.map((s, i) => (i === found.location.index ? newStep : s));
  return replaceList(doc, found.location.parentId, found.location.branch, newList);
}

function sanitizeBase(nodeType: string): string {
  const last = nodeType.includes(".")
    ? (nodeType.slice(nodeType.lastIndexOf(".") + 1) ?? nodeType)
    : nodeType;
  let base = last.replace(/[^A-Za-z0-9_]/g, "_");
  if (base === "") base = "step";
  if (/^[0-9]/.test(base)) base = `_${base}`;
  return base;
}

function nextAvailableId(taken: Set<string>, base: string): string {
  if (!taken.has(base) && !RESERVED_STEP_IDS.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/**
 * Generates a fresh, unique step ID from a node type, e.g. `"crm.loadContact"` → `"loadContact"`,
 * or `"loadContact_2"` if taken. Non-identifier characters are sanitized to `"_"`; a leading
 * digit is prefixed with `"_"`.
 */
export function generateStepId(doc: WorkflowDoc, nodeType: string): string {
  return nextAvailableId(allStepIds(doc), sanitizeBase(nodeType));
}

function rewriteRefs(expr: ValueExpr, idMap: Map<string, string>): ValueExpr {
  if (Array.isArray(expr)) return expr.map((e) => rewriteRefs(e, idMap));
  if (isRef(expr)) {
    const path = parseRefPath(expr.$ref);
    if (path.root === "steps" && path.stepId !== undefined && idMap.has(path.stepId)) {
      return { $ref: formatRefPath({ ...path, stepId: idMap.get(path.stepId) as string }) };
    }
    return expr;
  }
  if (isTpl(expr)) {
    let changed = false;
    const rewritten = parseTemplate(expr.$tpl)
      .map((part) => {
        if ("text" in part) return part.text;
        const path = parseRefPath(part.ref);
        if (path.root === "steps" && path.stepId !== undefined && idMap.has(path.stepId)) {
          changed = true;
          return `{{ ${formatRefPath({ ...path, stepId: idMap.get(path.stepId) as string })} }}`;
        }
        return `{{ ${part.ref} }}`;
      })
      .join("");
    return changed ? { $tpl: rewritten } : expr;
  }
  if (expr !== null && typeof expr === "object") {
    const out: Record<string, ValueExpr> = {};
    for (const [k, v] of Object.entries(expr)) out[k] = rewriteRefs(v, idMap);
    return out;
  }
  return expr;
}

function assignFreshIds(step: Step, taken: Set<string>, idMap: Map<string, string>): Step {
  const newId = nextAvailableId(taken, sanitizeBase(step.type));
  taken.add(newId);
  idMap.set(step.id, newId);
  const newStep: Step = { ...step, id: newId };
  if (step.branches) {
    const branches: Record<string, Step[]> = {};
    for (const [branchKey, branchSteps] of Object.entries(step.branches)) {
      branches[branchKey] = branchSteps.map((s) => assignFreshIds(s, taken, idMap));
    }
    newStep.branches = branches;
  }
  return newStep;
}

function rewriteSubtreeConfigs(step: Step, idMap: Map<string, string>): Step {
  const newStep: Step = {
    ...step,
    config: rewriteRefs(step.config, idMap) as Record<string, ValueExpr>,
  };
  if (step.branches) {
    const branches: Record<string, Step[]> = {};
    for (const [branchKey, branchSteps] of Object.entries(step.branches)) {
      branches[branchKey] = branchSteps.map((s) => rewriteSubtreeConfigs(s, idMap));
    }
    newStep.branches = branches;
  }
  return newStep;
}

/**
 * Whether `id` is one {@link generateStepId} would give a step of `nodeType` (`"httpRequest"`,
 * `"httpRequest_2"`), rather than one a person chose.
 */
export function isGeneratedStepId(id: string, nodeType: string): boolean {
  const base = sanitizeBase(nodeType);
  return id === base || (id.startsWith(`${base}_`) && /^[0-9]+$/.test(id.slice(base.length + 1)));
}

/**
 * Renames step `id` to `newId`, rewriting every reference to it: in step configs anywhere in the
 * tree and in the workflow's output mapping. Returns `doc` itself when the IDs are equal.
 *
 * @throws {FlowkitTreeError} If `id` doesn't exist, or `newId` is taken or not a valid step ID.
 */
export function renameStepId(doc: WorkflowDoc, id: string, newId: string): WorkflowDoc {
  if (id === newId) return doc;
  if (!findStep(doc, id)) throw new FlowkitTreeError(`Step "${id}" not found`);
  if (allStepIds(doc).has(newId) || !isValidStepId(newId))
    throw new FlowkitTreeError(`Step ID "${newId}" is taken or invalid`);
  const idMap = new Map([[id, newId]]);
  const rename = (step: Step): Step => ({
    ...step,
    id: step.id === id ? newId : step.id,
    config: rewriteRefs(step.config, idMap) as Record<string, ValueExpr>,
  });
  const walk = (list: Step[]): Step[] =>
    list.map((step) => {
      const renamed = rename(step);
      if (!step.branches) return renamed;
      const branches: Record<string, Step[]> = {};
      for (const [k, v] of Object.entries(step.branches)) branches[k] = walk(v);
      return { ...renamed, branches };
    });
  return {
    ...doc,
    steps: walk(doc.steps),
    ...(doc.output ? { output: rewriteRefs(doc.output, idMap) as Record<string, ValueExpr> } : {}),
  };
}

/**
 * Duplicates the step (and, if it branches, its whole subtree) with `id`, inserting the copy
 * directly after the original in the same list. Every step in the copy gets a fresh ID (via
 * {@link generateStepId}'s sanitization), and any `$ref`/`$tpl` inside the copy that pointed at a
 * step within the copied subtree is rewritten to point at that step's new ID.
 *
 * @throws {FlowkitTreeError} If `id` doesn't exist.
 */
export function duplicateStep(doc: WorkflowDoc, id: string): { doc: WorkflowDoc; newId: string } {
  const found = findStep(doc, id);
  if (!found) throw new FlowkitTreeError(`Step "${id}" not found`);

  const idMap = new Map<string, string>();
  const taken = allStepIds(doc);
  const structural = assignFreshIds(found.step, taken, idMap);
  const copy = rewriteSubtreeConfigs(structural, idMap);

  const newDoc = insertStep(
    doc,
    {
      parentId: found.location.parentId,
      branch: found.location.branch,
      index: found.location.index + 1,
    },
    copy,
  );
  return { doc: newDoc, newId: idMap.get(id) as string };
}
