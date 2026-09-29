// Import cycle: annotations.ts imports findStep/walkSteps from here. Neither module may use the
// other at top level (only inside functions), or one entry order sees it uninitialized. For
// example, annotations.ts must never `extends FlowlineTreeError` at top level.
import { upkeepSections } from "./annotations";
import { codeReadsStepOpaquely, rewriteCodeStepRefs } from "./code-refs";
import { isValidStepId, RESERVED_STEP_IDS } from "./ids";
import { formatRefPath, isRef, isTpl, parseRefPath, parseTemplate } from "./refs";
import type { Manifest, Step, ValueExpr, WorkflowDoc } from "./types";
import { UI_META_KEY } from "./ui";

/** Thrown when a tree operation targets a step, branch, or index that doesn't exist. */
export class FlowlineTreeError extends Error {
  /**
   * Error name, for `instanceof`-free checks across package copies. A `string` so subclasses
   * (such as `FlowlineCommandError`) can name themselves.
   */
  override readonly name: string = "FlowlineTreeError";
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

/**
 * @internal The step list of `step`'s branch `branch`, if the step holds it. Own keys only, so a
 * branch named `constructor` or `__proto__` is never an inherited property.
 */
export function branchList(step: Step, branch: string): Step[] | undefined {
  const branches = step.branches;
  return branches && Object.hasOwn(branches, branch) ? branches[branch] : undefined;
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
  return branchList(found.step, branch);
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
 * Inserts `step` at `loc`, immutably. Throws {@link FlowlineTreeError} if the location's parent or
 * branch doesn't exist, the index is out of `[0, length]` range, or `step.id` is already used.
 */
export function insertStep(doc: WorkflowDoc, loc: StepLocation, step: Step): WorkflowDoc {
  if (allStepIds(doc).has(step.id)) {
    throw new FlowlineTreeError(`Step id "${step.id}" already exists in the workflow`);
  }
  const list = getList(doc, loc.parentId, loc.branch);
  if (!list) {
    throw new FlowlineTreeError(
      `Cannot insert into parent "${loc.parentId ?? "<root>"}" branch "${loc.branch ?? ""}": not found`,
    );
  }
  if (loc.index < 0 || loc.index > list.length) {
    throw new FlowlineTreeError(`Insert index ${loc.index} out of range [0, ${list.length}]`);
  }
  const newList = [...list.slice(0, loc.index), step, ...list.slice(loc.index)];
  return replaceList(doc, loc.parentId, loc.branch, newList);
}

/**
 * @internal Inserts `steps` as one run starting at `loc` (one list copy), as {@link insertStep}
 * would one by one: throws {@link FlowlineTreeError} for a missing list, an out-of-range index,
 * or a top-level ID already used (in the doc or earlier in `steps`).
 */
export function insertStepRun(doc: WorkflowDoc, loc: StepLocation, steps: Step[]): WorkflowDoc {
  const taken = allStepIds(doc);
  for (const step of steps) {
    if (taken.has(step.id)) {
      throw new FlowlineTreeError(`Step id "${step.id}" already exists in the workflow`);
    }
    taken.add(step.id);
  }
  const list = getList(doc, loc.parentId, loc.branch);
  if (!list) {
    throw new FlowlineTreeError(
      `Cannot insert into parent "${loc.parentId ?? "<root>"}" branch "${loc.branch ?? ""}": not found`,
    );
  }
  if (loc.index < 0 || loc.index > list.length) {
    throw new FlowlineTreeError(`Insert index ${loc.index} out of range [0, ${list.length}]`);
  }
  const newList = [...list.slice(0, loc.index), ...steps, ...list.slice(loc.index)];
  return replaceList(doc, loc.parentId, loc.branch, newList);
}

/** {@link removeStep} without section upkeep. */
function removeRaw(doc: WorkflowDoc, id: string): { doc: WorkflowDoc; found: FoundStep } {
  const found = findStep(doc, id);
  if (!found) throw new FlowlineTreeError(`Step "${id}" not found`);
  const list = getList(doc, found.location.parentId, found.location.branch);
  if (!list) throw new FlowlineTreeError(`Step "${id}" not found`);
  const newList = list.filter((_, i) => i !== found.location.index);
  return { doc: replaceList(doc, found.location.parentId, found.location.branch, newList), found };
}

/**
 * Removes the step with `id`, immutably. A section whose `first` or `last` it was shrinks to the
 * nearest remaining member; a section with no members left is removed (see
 * {@link upkeepSections}). Throws {@link FlowlineTreeError} if not found.
 */
export function removeStep(doc: WorkflowDoc, id: string): WorkflowDoc {
  return upkeepSections(doc, removeRaw(doc, id).doc);
}

/**
 * Moves the step with `id` to location `to`, immutably. `to.index` is interpreted against the
 * destination list *after* the step has been removed from its original location. A member of a
 * section stays in it while it lands within the section's span; moved out, the section shrinks
 * (see {@link upkeepSections}).
 *
 * @throws {FlowlineTreeError} If `id` doesn't exist, or `to` names a parent within the moved
 *   step's own subtree (including the step itself).
 */
export function moveStep(doc: WorkflowDoc, id: string, to: StepLocation): WorkflowDoc {
  const { doc: removed, found } = removeRaw(doc, id);
  const next = insertStep(removed, to, found.step);
  return upkeepSections(doc, next, { moved: new Set([id]) });
}

/**
 * Replaces the step with `id` with `fn(step)`, immutably. If `fn` changes the ID, sections
 * naming the old ID follow it (references elsewhere are not rewritten; see
 * {@link renameStepId}). Throws if `id` doesn't exist.
 */
export function updateStep(doc: WorkflowDoc, id: string, fn: (s: Step) => Step): WorkflowDoc {
  const found = findStep(doc, id);
  if (!found) throw new FlowlineTreeError(`Step "${id}" not found`);
  const newStep = fn(found.step);
  if (newStep.id !== id && allStepIds(doc).has(newStep.id)) {
    throw new FlowlineTreeError(`Step id "${newStep.id}" already exists in the workflow`);
  }
  const list = getList(doc, found.location.parentId, found.location.branch);
  if (!list) throw new FlowlineTreeError(`Step "${id}" not found`);
  const newList = list.map((s, i) => (i === found.location.index ? newStep : s));
  const next = replaceList(doc, found.location.parentId, found.location.branch, newList);
  if (newStep.id === id) return upkeepSections(doc, next);
  return renameSectionEndpoints(
    upkeepSections(doc, next, { subst: new Map([[id, [newStep.id]]]) }),
    id,
    newStep.id,
  );
}

/**
 * `doc` with every section endpoint named `id` renamed to `newId`. Covers sections that
 * {@link upkeepSections} leaves alone because they are broken, so they keep naming the step.
 */
function renameSectionEndpoints(doc: WorkflowDoc, id: string, newId: string): WorkflowDoc {
  const sections = doc.sections;
  if (!sections?.some((s) => s.first === id || s.last === id)) return doc;
  return {
    ...doc,
    sections: sections.map((s) =>
      s.first === id || s.last === id
        ? { ...s, first: s.first === id ? newId : s.first, last: s.last === id ? newId : s.last }
        : s,
    ),
  };
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

/** @internal {@link generateStepId} against a set of taken IDs instead of a doc. */
export function freshStepId(taken: Set<string>, nodeType: string): string {
  return nextAvailableId(taken, sanitizeBase(nodeType));
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
 * Copies a run of steps (with subtrees) with fresh IDs unique in `doc`, remapping refs inside the copy
 * that point at steps of the run to their copies. Refs to steps outside the run are kept.
 *
 * `ids` maps every copied step's ID (subtrees included, pre-order) to its copy's. Fresh IDs come
 * from each step's node type, as {@link generateStepId}'s. Neither `doc` nor `steps` is changed,
 * and the copies aren't inserted anywhere.
 *
 * @example
 * const { steps, ids } = cloneRunWithFreshIds(doc, [load, email]);
 * // email's copy reads `steps.<load's copy>…`; ids.get("load") is load's copy's ID
 */
export function cloneRunWithFreshIds(
  doc: WorkflowDoc,
  steps: readonly Step[],
): { steps: Step[]; ids: Map<string, string> } {
  const ids = new Map<string, string>();
  const taken = allStepIds(doc);
  const structural = steps.map((s) => assignFreshIds(s, taken, ids));
  return { steps: structural.map((s) => rewriteSubtreeConfigs(s, ids)), ids };
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
 * The config keys of `step` that hold code (`widget: "code"`, like a Transform's `code`). Without
 * a manifest none do: a plain string there could be an email body that just says `steps.a`, so
 * it isn't touched.
 */
function codeKeys(step: Step, manifest: Manifest | undefined): Set<string> {
  if (!manifest) return new Set();
  const node = manifest.nodes.find((n) => n.type === step.type);
  const props = (node?.input as { properties?: Record<string, Record<string, unknown>> })
    ?.properties;
  const keys = new Set<string>();
  for (const [key, schema] of Object.entries(props ?? {})) {
    const meta = schema?.[UI_META_KEY] as { widget?: unknown } | undefined;
    if (meta?.widget === "code") keys.add(key);
  }
  return keys;
}

/** The code strings of a step's config (see {@link codeKeys}), by key. */
function codeValues(step: Step, manifest: Manifest | undefined): [string, string][] {
  const keys = codeKeys(step, manifest);
  return Object.entries(step.config).flatMap(([k, v]) =>
    typeof v === "string" && keys.has(k) ? [[k, v] as [string, string]] : [],
  );
}

/**
 * Whether some step's code (a Transform's `code`) might read step `id` in a way
 * {@link renameStepId} can't rewrite: `steps[key]`, `const { a } = steps` and the like, with the
 * ID also written in the code. Renaming the step would then break that code silently, so callers
 * that rename on their own (Replace regenerating a generated ID) keep the ID instead.
 * `manifest` tells code fields apart; without it no field is code, so this is always false.
 */
export function codeBlocksRename(doc: WorkflowDoc, id: string, manifest?: Manifest): boolean {
  let blocked = false;
  const walk = (list: Step[]) => {
    for (const step of list) {
      if (blocked) return;
      if (codeValues(step, manifest).some(([, code]) => codeReadsStepOpaquely(code, id))) {
        blocked = true;
        return;
      }
      for (const branch of Object.values(step.branches ?? {})) walk(branch);
    }
  };
  walk(doc.steps);
  return blocked;
}

/**
 * Renames step `id` to `newId`, rewriting every reference to it: in step configs anywhere in the
 * tree, in the workflow's output mapping, and in code (`steps.<id>`, `steps?.<id>`,
 * `steps['<id>']`, `steps["<id>"]`, also after `input.`, found with a tokenizer so comments and
 * strings are left alone). `manifest` tells code fields (`widget: "code"`) apart; without it only
 * `{{ }}` references (`$ref`/`$tpl`) are rewritten and no plain string is touched, since
 * nothing says which strings are code. Code that reads `steps` dynamically can't be
 * rewritten; check {@link codeBlocksRename} first. Returns `doc` itself when the IDs are equal.
 *
 * @throws {FlowlineTreeError} If `id` doesn't exist, or `newId` is taken or not a valid step ID.
 */
export function renameStepId(
  doc: WorkflowDoc,
  id: string,
  newId: string,
  manifest?: Manifest,
): WorkflowDoc {
  if (id === newId) return doc;
  if (!findStep(doc, id)) throw new FlowlineTreeError(`Step "${id}" not found`);
  if (allStepIds(doc).has(newId) || !isValidStepId(newId))
    throw new FlowlineTreeError(`Step ID "${newId}" is taken or invalid`);
  const idMap = new Map([[id, newId]]);
  const rename = (step: Step): Step => {
    const config = rewriteRefs(step.config, idMap) as Record<string, ValueExpr>;
    for (const [key, code] of codeValues(step, manifest)) {
      const next = rewriteCodeStepRefs(code, idMap);
      if (next !== code) config[key] = next;
    }
    return { ...step, id: step.id === id ? newId : step.id, config };
  };
  const walk = (list: Step[]): Step[] =>
    list.map((step) => {
      const renamed = rename(step);
      if (!step.branches) return renamed;
      const branches: Record<string, Step[]> = {};
      for (const [k, v] of Object.entries(step.branches)) branches[k] = walk(v);
      return { ...renamed, branches };
    });
  const next: WorkflowDoc = {
    ...doc,
    steps: walk(doc.steps),
    ...(doc.output ? { output: rewriteRefs(doc.output, idMap) as Record<string, ValueExpr> } : {}),
  };
  return renameSectionEndpoints(
    upkeepSections(doc, next, { subst: new Map([[id, [newId]]]) }),
    id,
    newId,
  );
}

/**
 * Duplicates the step (and, if it branches, its whole subtree) with `id`, inserting the copy
 * directly after the original in the same list. Every step in the copy gets a fresh ID (via
 * {@link generateStepId}'s sanitization), and any `$ref`/`$tpl` inside the copy that pointed at a
 * step within the copied subtree is rewritten to point at that step's new ID.
 *
 * @throws {FlowlineTreeError} If `id` doesn't exist.
 */
export function duplicateStep(doc: WorkflowDoc, id: string): { doc: WorkflowDoc; newId: string } {
  const found = findStep(doc, id);
  if (!found) throw new FlowlineTreeError(`Step "${id}" not found`);

  const {
    steps: [copy],
    ids: idMap,
  } = cloneRunWithFreshIds(doc, [found.step]);

  const newDoc = insertStep(
    doc,
    {
      parentId: found.location.parentId,
      branch: found.location.branch,
      index: found.location.index + 1,
    },
    copy as Step,
  );
  const newId = idMap.get(id) as string;
  // A copy of a member joins its section; a copy of `last` extends it.
  return { doc: upkeepSections(doc, newDoc, { subst: new Map([[id, [id, newId]]]) }), newId };
}
