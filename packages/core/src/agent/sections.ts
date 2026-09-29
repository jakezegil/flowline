/**
 * Section command handlers: `addSection`, `updateSection`, `removeSection`.
 *
 * Section upkeep: the tree operations rebuild `sections` from their input doc
 * (`upkeepSections(before, after)`), so a command must never edit `sections` and then run a tree
 * operation on the same edit. These handlers edit only `sections` and run no tree operation, so
 * each one's result is simply the next command's input: a later `moveStep` or `removeStep` in the
 * batch upkeeps the sections these commands wrote, and no upkeep can undo them.
 *
 * @module
 */
import {
  ANNOTATION_COLORS,
  isAnnotationColor,
  NOTE_MAX_CHARS,
  sectionIdFor,
  sectionRun,
} from "../annotations";
import { isValidStepId, STEP_ID_PATTERN } from "../ids";
import { branchList, findStep, type StepLocation } from "../tree";
import type { Section, Step, WorkflowDoc } from "../types";
import { type Command, CommandFailure, type Handler, type HandlerContext } from "./commands";
import { existingStep, unknownPlaceholder, wrongKind } from "./single";

type Cmd<Op extends Command["op"]> = Extract<Command, { op: Op }>;

/** A location without an `undefined` branch, for hints. */
function shown(loc: StepLocation): StepLocation {
  return {
    parentId: loc.parentId,
    ...(loc.branch !== undefined ? { branch: loc.branch } : {}),
    index: loc.index,
  };
}

/**
 * @internal The index in `sections` of the first section other than `skip` whose run overlaps
 * the run `first`…`last` (in one list), or -1. Broken sections overlap nothing.
 */
export function overlapping(
  doc: WorkflowDoc,
  sections: readonly Section[],
  first: string,
  last: string,
  skip = -1,
): number {
  const run = sectionRun(doc, { id: "", title: "", color: "gray", first, last });
  if (!run) return -1;
  return sections.findIndex((s, i) => {
    if (i === skip) return false;
    const r = sectionRun(doc, s);
    return (
      !!r &&
      r.parentId === run.parentId &&
      r.branch === run.branch &&
      r.start <= run.end &&
      run.start <= r.end
    );
  });
}

/**
 * @internal The run `first`…`last`: both real IDs, checked to be in one list and in order
 * (`run.invalid` otherwise), with the first step's location and the last one's index.
 */
export function stepRun(
  doc: WorkflowDoc,
  ctx: HandlerContext,
  firstRef: string,
  lastRef: string,
  paths: { first: string; last: string },
): { first: string; last: string; location: StepLocation; end: number } {
  const a = existingStep(doc, ctx, firstRef, paths.first);
  const z = existingStep(doc, ctx, lastRef, paths.last);
  const { parentId, branch, index } = a.location;
  if (
    parentId !== z.location.parentId ||
    branch !== z.location.branch ||
    index > z.location.index
  ) {
    const lists = parentId !== z.location.parentId || branch !== z.location.branch;
    throw new CommandFailure(
      "run.invalid",
      lists
        ? `Steps "${a.id}" and "${z.id}" are in different step lists; a run is in one list`
        : `Step "${a.id}" comes after "${z.id}"; first must be at or before last`,
      "",
      { first: shown(a.location), last: shown(z.location) },
    );
  }
  return { first: a.id, last: z.id, location: a.location, end: z.location.index };
}

/**
 * @internal {@link stepRun} with the run's top-level steps (`steps`) and their IDs (`ids`), in
 * order.
 */
export function runSteps(
  doc: WorkflowDoc,
  ctx: HandlerContext,
  firstRef: string,
  lastRef: string,
  paths: { first: string; last: string },
): ReturnType<typeof stepRun> & { steps: Step[]; ids: string[] } {
  const run = stepRun(doc, ctx, firstRef, lastRef, paths);
  const { parentId, branch, index } = run.location;
  const list =
    parentId === null
      ? doc.steps
      : (branchList(findStep(doc, parentId)?.step as Step, branch as string) ?? []);
  const steps = list.slice(index, run.end + 1);
  return { ...run, steps, ids: steps.map((s) => s.id) };
}

/** @internal The `section.overlap` failure: the run `first`…`last` overlaps `other`. */
export function overlapFailure(
  first: string,
  last: string,
  other: Section,
  path: string,
): CommandFailure {
  return new CommandFailure(
    "section.overlap",
    `The run "${first}"…"${last}" overlaps section "${other.id}"; sections in one list can't overlap`,
    path,
    { section: other.id },
  );
}

/**
 * The real IDs of `first`/`last`, checked to be one run (same list, in order) that overlaps no
 * section but the one at `skip`.
 */
function checkedRun(
  doc: WorkflowDoc,
  ctx: HandlerContext,
  firstRef: string,
  lastRef: string,
  paths: { first: string; last: string },
  skip = -1,
): { first: string; last: string } {
  const { first, last } = stepRun(doc, ctx, firstRef, lastRef, paths);
  const sections = doc.sections ?? [];
  const hit = overlapping(doc, sections, first, last, skip);
  if (hit >= 0) throw overlapFailure(first, last, sections[hit] as Section, "");
  return { first, last };
}

/**
 * The real section ID a section argument names. A section placeholder resolves (and is recorded
 * as used). A `$…` that no placeholder defines but a section literally has as its ID (a
 * hand-edited doc) names that section, so Fix can re-id it. A step's placeholder fails with
 * `placeholder.kind`; anything else starting with `$` with `placeholder.unknown`.
 */
function sectionRefId(doc: WorkflowDoc, ctx: HandlerContext, ref: unknown, path: string): string {
  if (typeof ref !== "string") {
    throw new CommandFailure("command.invalid", "A section ID must be a string", path);
  }
  if (!ref.startsWith("$")) return ref;
  const id = ctx.sectionPlaceholders.get(ref);
  if (id !== undefined) {
    ctx.used.set(ref, id);
    return id;
  }
  if (ctx.placeholders.has(ref)) throw wrongKind(ref, "step", "section", path);
  if ((doc.sections ?? []).some((s) => s.id === ref)) return ref;
  throw unknownPlaceholder(ctx, ref, path);
}

/** The index of the section `ref` names (the later one when IDs repeat); throws `section.notFound`. */
function sectionIndex(doc: WorkflowDoc, ctx: HandlerContext, ref: string, path: string): number {
  const id = sectionRefId(doc, ctx, ref, path);
  const sections = doc.sections ?? [];
  for (let i = sections.length - 1; i >= 0; i--) {
    if ((sections[i] as Section).id === id) return i;
  }
  throw new CommandFailure("section.notFound", `Section "${id}" not found`, path, {
    sections: [...new Set(sections.map((s) => s.id))],
  });
}

/** @internal `doc` with `sections` set; an empty list removes the key. */
export function withSections(doc: WorkflowDoc, sections: Section[]): WorkflowDoc {
  if (sections.length > 0) return { ...doc, sections };
  const { sections: _, ...rest } = doc;
  return rest;
}

/** @internal Throws `command.invalid` unless `note` is absent, `null` or a short enough string. */
export function checkNote(note: unknown, path: string): void {
  if (
    note !== undefined &&
    note !== null &&
    (typeof note !== "string" || note.length > NOTE_MAX_CHARS)
  ) {
    throw new CommandFailure(
      "command.invalid",
      `A note is a string of at most ${NOTE_MAX_CHARS} characters`,
      path,
      { expected: { type: "string", maxLength: NOTE_MAX_CHARS } },
    );
  }
}

/** @internal Throws `command.invalid` unless `color` is an annotation colour. */
export function checkColor(color: unknown, path: string): void {
  if (!isAnnotationColor(color)) {
    throw new CommandFailure(
      "command.invalid",
      `A colour is one of ${ANNOTATION_COLORS.join(", ")}`,
      path,
      { expected: { enum: [...ANNOTATION_COLORS] } },
    );
  }
}

/**
 * @internal A new section's ID: `id` checked to be valid (`id.invalid`) and free (`id.taken`,
 * failing at `path`), or one derived from `title` when `id` is absent.
 */
export function newSectionId(doc: WorkflowDoc, id: unknown, title: unknown, path: string): string {
  if (id === undefined) return sectionIdFor(doc, String(title));
  if (!isValidStepId(id)) {
    throw new CommandFailure(
      "id.invalid",
      `Section ID "${String(id)}" must start with a letter or underscore and contain only letters, digits and underscores`,
      path,
      { pattern: STEP_ID_PATTERN.source, suggested: sectionIdFor(doc, String(id)) },
    );
  }
  if ((doc.sections ?? []).some((s) => s.id === id)) {
    throw new CommandFailure("id.taken", `Section ID "${id}" is already used`, path, {
      suggested: sectionIdFor(doc, id),
    });
  }
  return id;
}

const addSection: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"addSection">;
  checkColor(cmd.color, "color");
  checkNote(cmd.note, "note");
  const run = checkedRun(doc, ctx, cmd.first, cmd.last, { first: "first", last: "last" });
  const id = newSectionId(doc, cmd.id, cmd.title, "id");
  const section: Section = {
    id,
    title: String(cmd.title),
    color: cmd.color,
    ...(cmd.note !== undefined && cmd.note !== "" ? { note: cmd.note } : {}),
    first: run.first,
    last: run.last,
  };
  return {
    doc: withSections(doc, [...(doc.sections ?? []), section]),
    created: id,
    kind: "section",
  };
};

const updateSection: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"updateSection">;
  const index = sectionIndex(doc, ctx, cmd.id, "id");
  const sections = doc.sections as Section[];
  const cur = sections[index] as Section;
  if (cmd.color !== undefined) checkColor(cmd.color, "color");
  checkNote(cmd.note, "note");
  let next: Section = cur;
  if (cmd.first !== undefined || cmd.last !== undefined) {
    const run = checkedRun(
      doc,
      ctx,
      cmd.first ?? cur.first,
      cmd.last ?? cur.last,
      {
        first: cmd.first !== undefined ? "first" : "id",
        last: cmd.last !== undefined ? "last" : "id",
      },
      index,
    );
    if (run.first !== cur.first || run.last !== cur.last) next = { ...next, ...run };
  }
  if (cmd.title !== undefined && cmd.title !== cur.title) next = { ...next, title: cmd.title };
  if (cmd.color !== undefined && cmd.color !== cur.color) next = { ...next, color: cmd.color };
  if (cmd.note !== undefined) {
    const note = cmd.note ?? "";
    if (note !== (cur.note ?? "")) {
      const { note: _, ...rest } = next;
      next = note === "" ? rest : { ...rest, note };
    }
  }
  if (next === cur) return { doc };
  const copy = sections.slice();
  copy[index] = next;
  return { doc: withSections(doc, copy) };
};

const removeSection: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"removeSection">;
  const index = sectionIndex(doc, ctx, cmd.id, "id");
  return {
    doc: withSections(
      doc,
      (doc.sections as Section[]).filter((_, i) => i !== index),
    ),
  };
};

/** @internal The section handlers by op. */
export const sectionHandlers: Record<string, Handler> = {
  addSection,
  updateSection,
  removeSection,
};
