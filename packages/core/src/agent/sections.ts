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
import { isAnnotationColor, NOTE_MAX_CHARS, sectionIdFor, sectionRun } from "../annotations";
import { isValidStepId, STEP_ID_PATTERN } from "../ids";
import type { StepLocation } from "../tree";
import type { Section, WorkflowDoc } from "../types";
import { type Command, CommandFailure, type Handler, type HandlerContext } from "./commands";
import { existingStep, placeholderId } from "./single";

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
        ? `Steps "${a.id}" and "${z.id}" are in different step lists; a section covers a run in one list`
        : `Step "${a.id}" comes after "${z.id}"; first must be at or before last`,
      "",
      { first: shown(a.location), last: shown(z.location) },
    );
  }
  const sections = doc.sections ?? [];
  const hit = overlapping(doc, sections, a.id, z.id, skip);
  if (hit >= 0) {
    const other = sections[hit] as Section;
    throw new CommandFailure(
      "section.overlap",
      `The run "${a.id}"…"${z.id}" overlaps section "${other.id}"; sections in one list can't overlap`,
      "",
      { section: other.id },
    );
  }
  return { first: a.id, last: z.id };
}

/** The index of the section `ref` names (the later one when IDs repeat); throws `section.notFound`. */
function sectionIndex(doc: WorkflowDoc, ctx: HandlerContext, ref: string, path: string): number {
  const id = placeholderId(ctx, ref, path);
  const sections = doc.sections ?? [];
  for (let i = sections.length - 1; i >= 0; i--) {
    if ((sections[i] as Section).id === id) return i;
  }
  throw new CommandFailure("section.notFound", `Section "${id}" not found`, path, {
    sections: [...new Set(sections.map((s) => s.id))],
  });
}

/** `doc` with `sections` set; an empty list removes the key. */
function withSections(doc: WorkflowDoc, sections: Section[]): WorkflowDoc {
  if (sections.length > 0) return { ...doc, sections };
  const { sections: _, ...rest } = doc;
  return rest;
}

function checkNote(note: unknown, path: string): void {
  if (
    note !== undefined &&
    note !== null &&
    (typeof note !== "string" || note.length > NOTE_MAX_CHARS)
  ) {
    throw new CommandFailure(
      "command.invalid",
      `A note is a string of at most ${NOTE_MAX_CHARS} characters`,
      path,
    );
  }
}

function checkColor(color: unknown, path: string): void {
  if (!isAnnotationColor(color)) {
    throw new CommandFailure("command.invalid", "Unknown colour", path);
  }
}

const addSection: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"addSection">;
  checkColor(cmd.color, "color");
  checkNote(cmd.note, "note");
  const run = checkedRun(doc, ctx, cmd.first, cmd.last, { first: "first", last: "last" });
  const taken = new Set((doc.sections ?? []).map((s) => s.id));
  let id: string;
  if (cmd.id !== undefined) {
    if (!isValidStepId(cmd.id)) {
      throw new CommandFailure(
        "id.invalid",
        `Section ID "${String(cmd.id)}" must start with a letter or underscore and contain only letters, digits and underscores`,
        "id",
        { pattern: STEP_ID_PATTERN.source, suggested: sectionIdFor(doc, String(cmd.id)) },
      );
    }
    if (taken.has(cmd.id)) {
      throw new CommandFailure("id.taken", `Section ID "${cmd.id}" is already used`, "id", {
        suggested: sectionIdFor(doc, cmd.id),
      });
    }
    id = cmd.id;
  } else {
    id = sectionIdFor(doc, String(cmd.title));
  }
  const section: Section = {
    id,
    title: String(cmd.title),
    color: cmd.color,
    ...(cmd.note !== undefined && cmd.note !== "" ? { note: cmd.note } : {}),
    first: run.first,
    last: run.last,
  };
  return { doc: withSections(doc, [...(doc.sections ?? []), section]), created: id };
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
