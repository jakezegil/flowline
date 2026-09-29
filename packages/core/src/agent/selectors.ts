/**
 * `where` selectors (spec §4.3): which steps a read or bulk command acts on.
 *
 * @module
 */
import { sectionRun } from "../annotations";
import { branchesFor, configValueAt } from "../json-schema";
import { indexManifest } from "../scope";
import { FlowlineTreeError, findStep } from "../tree";
import type { Manifest, Step, WorkflowDoc } from "../types";
import type { Where } from "./read-types";

/** Adds `step` and every step under it to `into`. */
function addSubtree(step: Step, into: Set<string>): void {
  into.add(step.id);
  for (const list of Object.values(step.branches ?? {})) {
    for (const s of list) addSubtree(s, into);
  }
}

/** Members of every valid section with ID `id`, and their subtrees. */
function sectionSteps(doc: WorkflowDoc, id: string): Set<string> {
  const out = new Set<string>();
  const sections = Array.isArray(doc.sections) ? doc.sections : [];
  for (const section of sections) {
    if (section.id !== id) continue;
    const run = sectionRun(doc, section);
    if (!run) continue;
    for (const memberId of run.ids) {
      const found = findStep(doc, memberId);
      if (found) addSubtree(found.step, out);
    }
  }
  return out;
}

/** Descendants (not the step itself) of `within.stepId`, optionally of one branch. */
function withinSteps(doc: WorkflowDoc, within: NonNullable<Where["within"]>): Set<string> {
  const out = new Set<string>();
  const found = findStep(doc, within.stepId);
  if (!found) return out;
  for (const [branch, list] of Object.entries(found.step.branches ?? {})) {
    if (within.branch !== undefined && branch !== within.branch) continue;
    for (const s of list) addSubtree(s, out);
  }
  return out;
}

const WHERE_KEYS = ["type", "section", "within", "nameContains", "configHas"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Throws a `FlowlineTreeError` for a malformed selector or one naming a missing step, branch or section. */
function checkWhere(doc: WorkflowDoc, manifest: Manifest, where: unknown): asserts where is Where {
  if (!isObject(where)) throw new FlowlineTreeError("where: expected an object");
  for (const key of Object.keys(where)) {
    if (!WHERE_KEYS.includes(key)) {
      throw new FlowlineTreeError(
        `where: unknown key "${key}" (expected one of ${WHERE_KEYS.join(", ")})`,
      );
    }
  }
  for (const key of ["type", "section", "nameContains", "configHas"]) {
    if (where[key] !== undefined && typeof where[key] !== "string") {
      throw new FlowlineTreeError(`where.${key}: expected a string`);
    }
  }
  const within = where.within;
  if (within !== undefined) {
    if (!isObject(within) || typeof within.stepId !== "string") {
      throw new FlowlineTreeError("where.within: expected { stepId, branch? }");
    }
    for (const key of Object.keys(within)) {
      if (key !== "stepId" && key !== "branch") {
        throw new FlowlineTreeError(`where.within: unknown key "${key}" (expected stepId, branch)`);
      }
    }
    const found = findStep(doc, within.stepId);
    if (!found) throw new FlowlineTreeError(`where.within: unknown step "${within.stepId}"`);
    const branch = within.branch;
    if (branch !== undefined) {
      const node = indexManifest(manifest).nodes.get(found.step.type);
      const declared = node ? branchesFor(node, found.step).map((b) => b.id) : [];
      if (
        typeof branch !== "string" ||
        (!declared.includes(branch) && !Object.hasOwn(found.step.branches ?? {}, branch))
      ) {
        throw new FlowlineTreeError(
          `where.within: step "${within.stepId}" has no branch "${String(branch)}"`,
        );
      }
    }
  }
  if (where.section !== undefined) {
    const sections = Array.isArray(doc.sections) ? doc.sections : [];
    if (!sections.some((s) => s.id === where.section)) {
      throw new FlowlineTreeError(`where.section: unknown section "${String(where.section)}"`);
    }
  }
}

/**
 * The IDs of the steps `where` matches, in pre-order (a step before its branch children). Fields
 * are ANDed, and `{}` matches every step:
 * - `type`: the exact node type;
 * - `section`: the section's members and their subtrees (a broken section matches nothing);
 * - `within`: every step under `stepId` (any depth), or under one of its branches;
 * - `nameContains`: a case-insensitive match on the display name (the step's `name`, else the
 *   node label, else the step ID);
 * - `configHas`: the config path is present (`configValueAt(config, path) !== undefined`).
 *
 * Throws a `FlowlineTreeError` for an unknown key, a field of the wrong type, an unknown
 * `within.stepId`, a `within.branch` the step doesn't have, or a `section` no section has.
 *
 * @example
 * matchSteps(doc, manifest, { type: "crm.sendEmail", section: "check" }) // ["notifyOwner"]
 */
export function matchSteps(doc: WorkflowDoc, manifest: Manifest, where: Where): string[] {
  checkWhere(doc, manifest, where);
  const nodes = indexManifest(manifest).nodes;
  const inSection = where.section !== undefined ? sectionSteps(doc, where.section) : undefined;
  const inWithin = where.within !== undefined ? withinSteps(doc, where.within) : undefined;
  const needle = where.nameContains?.toLowerCase();
  const out: string[] = [];
  const visit = (steps: Step[]) => {
    for (const step of steps) {
      if (matches(step)) out.push(step.id);
      for (const list of Object.values(step.branches ?? {})) visit(list);
    }
  };
  const matches = (step: Step): boolean => {
    if (where.type !== undefined && step.type !== where.type) return false;
    if (inSection && !inSection.has(step.id)) return false;
    if (inWithin && !inWithin.has(step.id)) return false;
    if (needle !== undefined) {
      const name =
        typeof step.name === "string" && step.name !== ""
          ? step.name
          : (nodes.get(step.type)?.name ?? step.id);
      if (!name.toLowerCase().includes(needle)) return false;
    }
    if (where.configHas !== undefined) {
      const config = typeof step.config === "object" && step.config !== null ? step.config : {};
      if (configValueAt(config, where.configHas) === undefined) return false;
    }
    return true;
  };
  visit(doc.steps);
  return out;
}
