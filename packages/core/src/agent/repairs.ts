/**
 * Repairs for the annotation issues (`section.broken`, `section.overlap`, `note.tooLong`): the
 * commands behind the issues pill's Fix.
 *
 * @module
 */
import {
  type AnnotationProblem,
  annotationProblems,
  isAnnotationColor,
  NOTE_MAX_CHARS,
  sectionIdFor,
  sectionRun,
} from "../annotations";
import { findStep } from "../tree";
import type { AnnotationColor, Section, WorkflowDoc } from "../types";
import type { Issue } from "../validate";
import type { Command } from "./commands";
import { overlapping } from "./sections";

/** Two issues are the same when they read the same. */
function sameIssue(a: Issue, b: Issue): boolean {
  return (
    a.code === b.code &&
    a.message === b.message &&
    a.stepId === b.stepId &&
    a.sectionId === b.sectionId
  );
}

/** Whether a section ID can be named in a command. */
function addressable(id: unknown): id is string {
  return typeof id === "string" && id !== "";
}

/**
 * Whether `commands` name the section `id` unambiguously. A literal `$…` section ID names that
 * section only while no earlier command in the batch defines the placeholder of that name (an
 * `addSection` at index n-1 defines `$n`).
 */
function literalSafe(commands: Command[], id: string): boolean {
  if (!/^\$[0-9]+$/.test(id)) return true;
  const n = Number(id.slice(1));
  if (commands[n - 1]?.op !== "addSection") return true;
  return !commands.some(
    (c, k) => k >= n && (c.op === "updateSection" || c.op === "removeSection") && c.id === id,
  );
}

/**
 * The section as `addSection` would take it back: a run that is valid (shrunk to its surviving
 * endpoint, swapped when reversed, its first step when it spans two lists), a known colour and a
 * note of at most 4000 chars; `undefined` when no endpoint survives.
 */
function repairedRun(doc: WorkflowDoc, s: Section): { first: string; last: string } | undefined {
  if (sectionRun(doc, s)) return { first: s.first, last: s.last };
  const a = findStep(doc, s.first);
  const z = findStep(doc, s.last);
  if (!a && !z) return undefined;
  if (!a || !z) {
    const id = a ? s.first : s.last;
    return { first: id, last: id };
  }
  const sameList =
    a.location.parentId === z.location.parentId && a.location.branch === z.location.branch;
  return sameList ? { first: s.last, last: s.first } : { first: s.first, last: s.first };
}

/**
 * Commands that re-add section `s` (to be removed just before) under `id`, repaired as needed;
 * `[]` when it can't come back (no endpoint left, or it would overlap a section in `others`).
 */
function readd(doc: WorkflowDoc, s: Section, id: string, others: readonly Section[]): Command[] {
  const run = repairedRun(doc, s);
  if (!run || overlapping(doc, others, run.first, run.last) >= 0) return [];
  const color: AnnotationColor = isAnnotationColor(s.color) ? s.color : "gray";
  const note = typeof s.note === "string" ? s.note.slice(0, NOTE_MAX_CHARS) : undefined;
  return [
    {
      op: "addSection",
      first: run.first,
      last: run.last,
      title: String(s.title ?? ""),
      color,
      ...(note ? { note } : {}),
      id,
    },
  ];
}

/**
 * A new run for section `index` shrunk or swapped to `run`, or its removal when that run would
 * overlap another section (the command would fail).
 */
function retarget(
  doc: WorkflowDoc,
  sections: readonly Section[],
  index: number,
  candidates: { first?: string; last?: string }[],
): Command {
  const s = sections[index] as Section;
  for (const c of candidates) {
    const first = c.first ?? s.first;
    const last = c.last ?? s.last;
    if (overlapping(doc, sections, first, last, index) < 0) {
      return { op: "updateSection", id: s.id, ...c };
    }
  }
  return { op: "removeSection", id: s.id };
}

/**
 * Commands that fix one `section.broken`, `section.overlap` or `note.tooLong` issue, or `[]`
 * when it can't be fixed automatically (another kind of issue, or a stale one).
 *
 * - A missing endpoint: shrink the section to the one that survives, or remove it.
 * - Reversed: swap `first` and `last`. In different branches: shrink it to its first step.
 * - A bad colour: gray. A long note: cut to 4000 chars.
 * - A duplicate or invalid section ID: remove the section, then add it back with the same run,
 *   title, colour and note under a fresh ID from `sectionIdFor`. A hand-edited `$…` ID is
 *   named literally (no placeholder of that name is defined in the batch).
 * - An overlap: remove the later section.
 *
 * `updateSection` and `removeSection` act on the later of two sections that share an ID, so a
 * fix for an earlier one first re-adds each later same-ID section under a fresh ID. A run fix
 * that would overlap another section removes the section instead.
 *
 * @example
 * const issue = validateWorkflow(doc, manifest).find((i) => i.code === "section.broken")!;
 * apply(doc, annotationRepairs(doc, issue), manifest)
 */
export function annotationRepairs(doc: WorkflowDoc, issue: Issue): Command[] {
  if (
    issue.code !== "section.broken" &&
    issue.code !== "section.overlap" &&
    issue.code !== "note.tooLong"
  ) {
    return [];
  }
  const problems = annotationProblems(doc).filter((p) => sameIssue(p.issue, issue));
  // Identical issues from identical sections: fix the later one.
  const problem = problems[problems.length - 1] as AnnotationProblem | undefined;
  if (!problem) return [];
  if (problem.kind === "stepNote") {
    const note = findStep(doc, problem.stepId)?.step.note ?? "";
    return [{ op: "setNote", id: problem.stepId, note: note.slice(0, NOTE_MAX_CHARS) }];
  }

  const original = doc.sections as Section[];
  const target = original[problem.index] as Section;
  if (!addressable(target.id)) return [];
  const commands: Command[] = [];
  // `sections` as the commands so far leave them; `at` is the target's index there.
  let sections = original.slice();
  const at = problem.index;
  const freshId = (s: Section) => sectionIdFor({ ...doc, sections }, String(s.title ?? ""));

  // Re-id the later sections that share the target's ID, last first, so the target becomes the
  // one `updateSection`/`removeSection` act on.
  for (let j = sections.length - 1; j > at; j--) {
    const later = sections[j] as Section;
    if (later.id !== target.id) continue;
    const id = freshId(later);
    const rest = sections.filter((_, i) => i !== j);
    const back = readd(doc, later, id, rest);
    commands.push({ op: "removeSection", id: target.id }, ...back);
    const added = back[0] as Extract<Command, { op: "addSection" }> | undefined;
    sections = added ? [...rest, { ...later, id, first: added.first, last: added.last }] : rest;
  }

  switch (problem.kind) {
    case "missing": {
      const survivor = [target.first, target.last].find((id) => findStep(doc, id));
      commands.push(
        survivor === undefined
          ? { op: "removeSection", id: target.id }
          : retarget(doc, sections, at, [{ first: survivor, last: survivor }]),
      );
      break;
    }
    case "reversed":
      commands.push(
        retarget(doc, sections, at, [
          { first: target.last, last: target.first },
          { last: target.first },
        ]),
      );
      break;
    case "branches":
      commands.push(retarget(doc, sections, at, [{ last: target.first }]));
      break;
    case "color":
      commands.push({ op: "updateSection", id: target.id, color: "gray" });
      break;
    case "sectionNote":
      commands.push({
        op: "updateSection",
        id: target.id,
        note: String(target.note ?? "").slice(0, NOTE_MAX_CHARS),
      });
      break;
    case "overlap":
      commands.push({ op: "removeSection", id: target.id });
      break;
    case "id": {
      const id = freshId(target);
      const rest = sections.filter((s) => s !== target);
      commands.push({ op: "removeSection", id: target.id }, ...readd(doc, target, id, rest));
      break;
    }
  }
  return literalSafe(commands, target.id) ? commands : [];
}
