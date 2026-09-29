/**
 * Step notes, step colours and sections: visual annotations on a workflow doc. The engine
 * ignores them; the tree operations keep sections pointing at real runs of steps.
 *
 * @module
 */
import { isValidStepId } from "./ids";
// Import cycle: tree.ts imports upkeepSections from here. Neither module may use the other at top
// level (only inside functions), or one entry order sees it uninitialized. For example, never
// write `class X extends FlowlineTreeError` in this file.
import { branchList, findStep, walkSteps } from "./tree";
import type { AnnotationColor, Section, Step, WorkflowDoc } from "./types";
import type { Issue } from "./validate";

/** Every {@link AnnotationColor}, in palette order. */
export const ANNOTATION_COLORS: readonly AnnotationColor[] = [
  "yellow",
  "blue",
  "green",
  "pink",
  "purple",
  "gray",
];

/** The longest a step or section note may be, in characters. */
export const NOTE_MAX_CHARS = 4000;

/** Whether `v` is one of the six {@link ANNOTATION_COLORS}. */
export function isAnnotationColor(v: unknown): v is AnnotationColor {
  return typeof v === "string" && (ANNOTATION_COLORS as readonly string[]).includes(v);
}

/** The step list a location points at. */
function listAt(doc: WorkflowDoc, parentId: string | null, branch: string | undefined): Step[] {
  if (parentId === null) return doc.steps;
  if (branch === undefined) return [];
  const owner = findStep(doc, parentId)?.step;
  return (owner && branchList(owner, branch)) ?? [];
}

/** A key identifying one step list. */
function listKey(parentId: string | null, branch: string | undefined): string {
  return JSON.stringify([parentId, branch ?? null]);
}

/**
 * The run a section covers, or `undefined` when it is broken (missing endpoint, two lists,
 * reversed). A bad colour or an invalid/duplicate section ID does not make the run undefined.
 */
export function sectionRun(
  doc: WorkflowDoc,
  section: Section,
):
  | { parentId: string | null; branch?: string; start: number; end: number; ids: string[] }
  | undefined {
  const a = findStep(doc, section.first);
  const z = findStep(doc, section.last);
  if (!a || !z) return undefined;
  const { parentId, branch } = a.location;
  if (parentId !== z.location.parentId || branch !== z.location.branch) return undefined;
  const start = a.location.index;
  const end = z.location.index;
  if (start > end) return undefined;
  const ids = listAt(doc, parentId, branch)
    .slice(start, end + 1)
    .map((s) => s.id);
  return { parentId, ...(branch !== undefined ? { branch } : {}), start, end, ids };
}

/** The innermost section whose run contains step `id` in the step's own list, if any. */
export function sectionOf(doc: WorkflowDoc, id: string): Section | undefined {
  if (!doc.sections?.length) return undefined;
  const found = findStep(doc, id);
  if (!found) return undefined;
  const { parentId, branch, index } = found.location;
  let best: Section | undefined;
  let bestSize = Number.POSITIVE_INFINITY;
  for (const section of doc.sections) {
    const run = sectionRun(doc, section);
    if (!run || run.parentId !== parentId || run.branch !== branch) continue;
    if (index < run.start || index > run.end) continue;
    const size = run.end - run.start;
    if (size < bestSize) {
      best = section;
      bestSize = size;
    }
  }
  return best;
}

/** How an edit relates old section members to the new doc. */
export interface SectionEffect {
  /** Old member ID → the IDs that take its place (renames, wrap, replace, duplicate, unwrap). */
  subst?: ReadonlyMap<string, readonly string[]>;
  /**
   * IDs the edit moved explicitly. A moved member stays in its section only when it lands within
   * the span of the members that didn't move (or when the whole run moved).
   */
  moved?: ReadonlySet<string>;
}

/** Where a step sits in `after`: its list and index. */
interface Place {
  key: string;
  index: number;
}

/** Every step's place, first pre-order match (as {@link findStep}), plus each list's IDs. */
function indexPlaces(doc: WorkflowDoc): {
  places: Map<string, Place>;
  lists: Map<string, string[]>;
} {
  const places = new Map<string, Place>();
  const lists = new Map<string, string[]>();
  walkSteps(doc, (step, loc) => {
    const key = listKey(loc.parentId, loc.branch);
    let list = lists.get(key);
    if (!list) {
      list = [];
      lists.set(key, list);
    }
    list[loc.index] = step.id;
    if (!places.has(step.id)) places.set(step.id, { key, index: loc.index });
  });
  return { places, lists };
}

/**
 * Whether a moved member at `i` stays: it lies within the anchors' span `[f, z]`, or next to it
 * with only moved members of this section in between.
 */
function staysNear(i: number, f: number, z: number, list: string[], movedMembers: Set<string>) {
  if (i >= f && i <= z) return true;
  const [lo, hi] = i < f ? [i, f] : [z, i];
  for (let j = lo + 1; j < hi; j++) {
    if (!movedMembers.has(list[j] as string)) return false;
  }
  return true;
}

/**
 * The section's new `[first, last]` in `after` (`undefined` if nothing is left), and whether its
 * whole run moved in the edit (every survivor is in `effect.moved`).
 */
function upkeepOne(
  members: string[],
  places: Map<string, Place>,
  lists: Map<string, string[]>,
  effect: SectionEffect,
): { span: [string, string] | undefined; runMoved: boolean } {
  const survivors: string[] = [];
  const seen = new Set<string>();
  for (const id of members) {
    for (const next of effect.subst?.get(id) ?? [id]) {
      if (!seen.has(next) && places.has(next)) {
        seen.add(next);
        survivors.push(next);
      }
    }
  }
  if (survivors.length === 0) return { span: undefined, runMoved: false };

  const moved = effect.moved;
  const runMoved = !!moved && survivors.every((id) => moved.has(id));
  let kept = survivors;
  if (moved && !runMoved && survivors.some((id) => moved.has(id))) {
    const anchors = survivors.filter((id) => !moved.has(id));
    const movedMembers = new Set(survivors.filter((id) => moved.has(id)));
    const key = (places.get(anchors[0] as string) as Place).key;
    const inList = anchors
      .map((id) => places.get(id) as Place)
      .filter((p) => p.key === key)
      .map((p) => p.index);
    const f = Math.min(...inList);
    const z = Math.max(...inList);
    const list = lists.get(key) ?? [];
    kept = survivors.filter((id) => {
      if (!movedMembers.has(id)) return true;
      const p = places.get(id) as Place;
      return p.key === key && staysNear(p.index, f, z, list, movedMembers);
    });
  }

  const key = (places.get(kept[0] as string) as Place).key;
  const indices = kept
    .map((id) => places.get(id) as Place)
    .filter((p) => p.key === key)
    .map((p) => p.index);
  const list = lists.get(key) ?? [];
  return {
    span: [list[Math.min(...indices)] as string, list[Math.max(...indices)] as string],
    runMoved,
  };
}

/** Whether two runs (by place) share a list and intersect. */
function overlaps(a: [Place, Place], b: [Place, Place]): boolean {
  return a[0].key === b[0].key && a[0].index <= b[1].index && b[0].index <= a[1].index;
}

/**
 * `after` with its `sections` updated for an edit from `before`.
 *
 * The sections are rebuilt from `before.sections`: `after.sections` is never read when something
 * changes, so callers must not pre-edit `after.sections` (edit sections after upkeep instead).
 *
 * 1. A section's members are its run in `before`. A section already broken there is kept as is.
 * 2. Each member is replaced by `effect.subst.get(id) ?? [id]`, and IDs gone from `after` are
 *    dropped. A member in `effect.moved` stays only if the whole run moved, or if it landed within
 *    the span of the members that didn't move (or next to it, past only moved members).
 * 3. The new `first`/`last` are the lowest and highest index of the survivors in the list of the
 *    first survivor; steps between them are members by contiguity. No survivor: the section is
 *    removed.
 * 4. If the edit makes two sections overlap in one list, one is dropped: the section whose whole
 *    run moved, keeping the one whose anchors stayed put. If both moved, or neither did, the later
 *    one in `sections` is dropped. Pairs that already overlapped in `before`, or that involve a
 *    section broken there, are left alone for the validator (`section.overlap`) to report.
 * 5. `sections` is removed from the doc when it becomes empty (an empty `[]` stays `[]`).
 * 6. Identity: when no section changes, `after` itself is returned, so its `sections` array is
 *    the old one (`toBe`).
 */
export function upkeepSections(
  before: WorkflowDoc,
  after: WorkflowDoc,
  effect: SectionEffect = {},
): WorkflowDoc {
  const sections = before.sections;
  if (!sections?.length) return after;
  const { places, lists } = indexPlaces(after);

  let changed = false;
  const runs = sections.map((section) => sectionRun(before, section));
  /** Whether each section's whole run moved in this edit. */
  const runMoved: boolean[] = [];
  /** Each section after upkeep, or `null` when removed. */
  const next: (Section | null)[] = sections.map((section, i) => {
    const run = runs[i];
    runMoved[i] = false;
    if (!run) return section;
    const result = upkeepOne(run.ids, places, lists, effect);
    runMoved[i] = result.runMoved;
    const span = result.span;
    if (!span) {
      changed = true;
      return null;
    }
    const [first, last] = span;
    if (first === section.first && last === section.last) return section;
    changed = true;
    return { ...section, first, last };
  });

  // Resolve overlaps the edit created (rule 4). Pairs that already overlapped in `before`, or with
  // a section broken there, are left to the validator, so a hand-edited doc isn't silently
  // repaired.
  const overlappedBefore = (i: number, j: number) => {
    const [ri, rj] = [runs[i], runs[j]];
    if (!ri || !rj) return true;
    return (
      ri.parentId === rj.parentId &&
      ri.branch === rj.branch &&
      ri.start <= rj.end &&
      rj.start <= ri.end
    );
  };
  const spans: ([Place, Place] | undefined)[] = next.map((section) => {
    if (!section) return undefined;
    const a = places.get(section.first);
    const z = places.get(section.last);
    return a && z && a.key === z.key && a.index <= z.index ? [a, z] : undefined;
  });
  for (let j = 0; j < next.length; j++) {
    const sj = spans[j];
    if (!next[j] || !sj) continue;
    for (let i = 0; i < j; i++) {
      const si = spans[i];
      if (!next[i] || !si || !overlaps(si, sj)) continue;
      if (overlappedBefore(i, j)) continue;
      // Drop the section that moved onto the other; else the later one.
      const victim = runMoved[i] && !runMoved[j] ? i : j;
      next[victim] = null;
      spans[victim] = undefined;
      changed = true;
      if (victim === j) break;
    }
  }

  if (!changed) return after;
  const kept = next.filter((s): s is Section => s !== null);
  if (kept.length === 0) {
    const { sections: _dropped, ...rest } = after;
    return rest;
  }
  return { ...after, sections: kept };
}

/**
 * A fresh section ID from a title, unique among `doc.sections`.
 * Rule: lowercase the title, replace each run of characters outside [a-z0-9] with "_", and trim
 * "_" from both ends. Cut to 32 chars, prefix "section_" if the slug starts with a digit, and use
 * "section" when nothing is left. If the ID is taken, append "_2", "_3", …
 * ("Check the deal" → "check_the_deal", then "check_the_deal_2").
 */
export function sectionIdFor(doc: WorkflowDoc, title: string): string {
  let slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32)
    .replace(/_+$/, "");
  if (/^[0-9]/.test(slug)) slug = `section_${slug}`;
  if (slug === "") slug = "section";
  const taken = new Set((doc.sections ?? []).map((s) => s.id));
  const free = (id: string) => !taken.has(id) && isValidStepId(id);
  if (free(slug)) return slug;
  let n = 2;
  while (!free(`${slug}_${n}`)) n++;
  return `${slug}_${n}`;
}

/** A section issue: `sectionId`, plus `stepId` = `first` when that step exists. */
function sectionIssue(
  doc: WorkflowDoc,
  section: Section,
  code: Issue["code"],
  message: string,
): Issue {
  return {
    code,
    severity: "warning",
    message,
    sectionId: section.id,
    ...(findStep(doc, section.first) ? { stepId: section.first } : {}),
  };
}

function tooLong(note: unknown): string | undefined {
  return typeof note === "string" && note.length > NOTE_MAX_CHARS
    ? `This note is ${note.length} characters; notes can be ${NOTE_MAX_CHARS} at most`
    : undefined;
}

/** @internal Validator checks: `section.broken`, `section.overlap`, `note.tooLong`. */
export function annotationIssues(doc: WorkflowDoc): Issue[] {
  const issues: Issue[] = [];
  walkSteps(doc, (step) => {
    const message = tooLong(step.note);
    if (message)
      issues.push({ code: "note.tooLong", severity: "warning", message, stepId: step.id });
  });

  const sections = Array.isArray(doc.sections) ? doc.sections : [];
  const seenIds = new Set<string>();
  const runs: ReturnType<typeof sectionRun>[] = [];
  for (const section of sections) {
    const broken = (reason: string) =>
      issues.push(
        sectionIssue(
          doc,
          section,
          "section.broken",
          `Section “${section.title}” no longer covers a run of steps: ${reason}`,
        ),
      );
    const run = sectionRun(doc, section);
    runs.push(run);
    if (!run) {
      const missing = [section.first, section.last].filter((id) => !findStep(doc, id));
      if (missing.length > 0) {
        for (const id of new Set(missing)) broken(`step "${id}" is missing`);
      } else {
        const a = findStep(doc, section.first)?.location;
        const z = findStep(doc, section.last)?.location;
        broken(
          a?.parentId !== z?.parentId || a?.branch !== z?.branch
            ? "its first and last steps are in different branches"
            : "its first step comes after its last",
        );
      }
    }
    if (!isAnnotationColor(section.color)) {
      broken(`its colour "${String(section.color)}" isn't one of ${ANNOTATION_COLORS.join(", ")}`);
    }
    if (!isValidStepId(section.id) || seenIds.has(section.id)) {
      broken(`its ID "${String(section.id)}" is invalid or used twice`);
    }
    seenIds.add(section.id);
    const message = tooLong(section.note);
    if (message) issues.push(sectionIssue(doc, section, "note.tooLong", message));
  }

  for (let j = 0; j < sections.length; j++) {
    const rj = runs[j];
    if (!rj) continue;
    for (let i = 0; i < j; i++) {
      const ri = runs[i];
      if (!ri || ri.parentId !== rj.parentId || ri.branch !== rj.branch) continue;
      if (ri.start <= rj.end && rj.start <= ri.end) {
        const [a, b] = [sections[i] as Section, sections[j] as Section];
        issues.push(
          sectionIssue(doc, b, "section.overlap", `Sections “${a.title}” and “${b.title}” overlap`),
        );
      }
    }
  }
  return issues;
}
