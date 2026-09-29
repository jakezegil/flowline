/**
 * `where` selectors (spec §4.3): which steps a read or bulk command acts on.
 *
 * @module
 */
import { sectionRun } from "../annotations";
import { configValueAt } from "../json-schema";
import { indexManifest } from "../scope";
import { findStep } from "../tree";
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

/**
 * The IDs of the steps `where` matches, in pre-order (a step before its branch children). Fields
 * are ANDed, and `{}` matches every step:
 * - `type`: the exact node type;
 * - `section`: the section's members and their subtrees (a broken or unknown section matches
 *   nothing);
 * - `within`: every step under `stepId` (any depth), or under one of its branches;
 * - `nameContains`: a case-insensitive match on the display name (the step's `name`, else the
 *   node label, else the step ID);
 * - `configHas`: the config path is present (`configValueAt(config, path) !== undefined`).
 *
 * @example
 * matchSteps(doc, manifest, { type: "crm.sendEmail", section: "check" }) // ["notifyOwner"]
 */
export function matchSteps(doc: WorkflowDoc, manifest: Manifest, where: Where): string[] {
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
