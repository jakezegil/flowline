/**
 * Bulk add: `insertSteps` (with the store's verbatim paste) and `replaceSteps`. Fragments are
 * built whole, inserted, and the candidate doc validated once; a problem on an inserted step
 * whose code is on the fragment reject list fails the command at the fragment's path.
 *
 * Section upkeep: `replaceSteps` removes the run and then upkeeps each section once, from the
 * input doc: in a section holding the whole run the replaced members stand for the new top-level
 * steps (`subst`), so it holds the new steps; every other section just loses the removed steps
 * (see `replacedSections`).
 *
 * @module
 */
import { sectionRun, upkeepSections } from "../annotations";
import { isValidStepId, RESERVED_STEP_IDS, STEP_ID_PATTERN } from "../ids";
import { branchesFor, carryDefs, configValueAt, derefSchema, schemaAtPath } from "../json-schema";
import { createStep, jsonEqual, syncBranches } from "../step-factory";
import {
  allStepIds,
  branchList,
  findStep,
  freshStepId,
  insertStepRun,
  removeStep,
  type StepLocation,
} from "../tree";
import type { JSONSchema, NodeManifest, Section, Step, ValueExpr, WorkflowDoc } from "../types";
import { type IssueCode, validateWorkflow } from "../validate";
import { fitSchemaHint, formatPath } from "./command-schema";
import {
  type Command,
  type CommandErrorCode,
  CommandFailure,
  type Fragment,
  type Handler,
  type HandlerContext,
  type SectionInput,
} from "./commands";
import { compactSchema } from "./compact-schema";
import { resolveValuePlaceholders } from "./placeholders";
import { availableRefs } from "./reads";
import {
  checkColor,
  checkNote,
  newSectionId,
  overlapFailure,
  overlapping,
  stepRun,
  withSections,
} from "./sections";
import { locate, nodeOf, resolvedValue } from "./single";

type Cmd<Op extends Command["op"]> = Extract<Command, { op: Op }>;
type Path = (string | number)[];

/** The validation codes that fail a non-verbatim fragment (on an inserted step). */
const REJECTED = new Set<IssueCode>([
  "node.unknown",
  "branch.unknown",
  "config.invalid",
  "ref.syntax",
  "ref.unresolved",
  "ref.outOfScope",
  "step.invalidId",
  "step.duplicateId",
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A fragment step after pass 1: its ID and node known, its branches' fragments too. */
interface Pending {
  frag: Fragment;
  id: string;
  /** The node, or `undefined` for a verbatim step of an unknown type. */
  node: NodeManifest | undefined;
  path: Path;
  branches?: [string, Pending[]][];
}

/** How fragments are built: normal mode (defaults, declared branches), or verbatim paste. */
interface Build {
  ctx: HandlerContext;
  verbatim: boolean;
  /** Step IDs in use: the doc's plus those assigned so far. */
  taken: Set<string>;
  /** Each new step's fragment path, for mapping issues back. */
  paths: Map<string, Path>;
}

/** Throws `id.invalid` or `id.taken` unless `id` can name a new step. */
function checkId(b: Build, id: unknown, path: Path): asserts id is string {
  const p = formatPath(path);
  if (typeof id !== "string") {
    throw new CommandFailure("command.invalid", "A step ID must be a string", p);
  }
  if (!b.verbatim && !isValidStepId(id)) {
    throw new CommandFailure(
      "id.invalid",
      `Step ID "${id}" must start with a letter or underscore and contain only letters, digits and underscores`,
      p,
      {
        rule: `Start with a letter or underscore, then letters, digits and underscores only; not ${[...RESERVED_STEP_IDS].join(", ")}`,
        pattern: STEP_ID_PATTERN.source,
        suggested: freshStepId(b.taken, id),
      },
    );
  }
  if (b.taken.has(id)) {
    throw new CommandFailure("id.taken", `Step ID "${id}" is already used`, p, {
      suggested: freshStepId(b.taken, id),
    });
  }
}

/**
 * Pass 1, pre-order: every fragment's ID (given or generated) and node, its `ref` registered as
 * `$<ref>`, and (normal mode) its branch keys checked against what its node declares.
 */
function plan(b: Build, frags: unknown, path: Path, top = false): Pending[] {
  if (!Array.isArray(frags) || (top && frags.length === 0)) {
    throw new CommandFailure(
      "command.invalid",
      top ? "steps must be a non-empty array of fragments" : "A branch is an array of fragments",
      formatPath(path),
    );
  }
  return frags.map((raw, i) => {
    const here = [...path, i];
    if (!isObject(raw)) {
      throw new CommandFailure("command.invalid", "A fragment must be an object", formatPath(here));
    }
    const frag = raw as unknown as Fragment;
    let node: NodeManifest | undefined;
    if (b.verbatim) {
      if (typeof frag.type !== "string" || frag.type === "") {
        throw new CommandFailure(
          "command.invalid",
          "A fragment's type must be a non-empty string",
          formatPath([...here, "type"]),
        );
      }
      node = b.ctx.nodes.get(frag.type);
    } else {
      node = nodeOf(b.ctx, frag.type, formatPath([...here, "type"]));
    }
    let id: string;
    if (frag.id !== undefined) {
      checkId(b, frag.id, [...here, "id"]);
      id = frag.id;
    } else {
      id = freshStepId(b.taken, frag.type);
    }
    b.taken.add(id);
    b.paths.set(id, here);

    if (frag.ref !== undefined) {
      const refPath = formatPath([...here, "ref"]);
      if (typeof frag.ref !== "string" || !STEP_ID_PATTERN.test(frag.ref)) {
        throw new CommandFailure(
          "command.invalid",
          "A ref starts with a letter or underscore, then letters, digits and underscores",
          refPath,
          { pattern: STEP_ID_PATTERN.source },
        );
      }
      const name = `$${frag.ref}`;
      if (b.ctx.placeholders.has(name) || b.ctx.sectionPlaceholders.has(name)) {
        throw new CommandFailure(
          "command.invalid",
          `The ref "${frag.ref}" is already used in this batch; each ref names one step`,
          refPath,
        );
      }
      b.ctx.placeholders.set(name, id);
      b.ctx.used.set(name, id);
    }

    if (frag.config !== undefined && !isObject(frag.config)) {
      throw new CommandFailure(
        "command.invalid",
        "config must be an object",
        formatPath([...here, "config"]),
      );
    }
    // Checked here too for trusted callers, which skip the shape check (as `section` is).
    if (frag.color !== undefined) checkColor(frag.color, formatPath([...here, "color"]));
    checkNote(frag.note, formatPath([...here, "note"]));
    const pending: Pending = { frag, id, node, path: here };
    if (frag.branches === undefined) return pending;
    if (!isObject(frag.branches)) {
      throw new CommandFailure(
        "command.invalid",
        "branches must be an object of fragment lists",
        formatPath([...here, "branches"]),
      );
    }
    const keys = Object.keys(frag.branches);
    if (!b.verbatim && node) checkBranchKeys(node, id, frag, keys, [...here, "branches"]);
    pending.branches = keys.map((key) => {
      const list = (frag.branches as Record<string, unknown>)[key];
      return [key, plan(b, list, [...here, "branches", key])];
    });
    return pending;
  });
}

/** Throws `branch.unknown` for a branch key the node doesn't declare. */
function checkBranchKeys(
  node: NodeManifest,
  id: string,
  frag: Fragment,
  keys: string[],
  path: Path,
): void {
  const probe: Step = { id, type: node.type, config: { ...(frag.config ?? {}) } };
  // As the validator: branches from a non-literal config value can't be known statically.
  const spec = node.branches;
  if (spec.kind === "fromConfig" && !Array.isArray(configValueAt(probe.config, spec.configPath))) {
    return;
  }
  const declared = branchesFor(node, probe).map((x) => x.id);
  for (const key of keys) {
    if (!declared.includes(key)) {
      throw new CommandFailure(
        "branch.unknown",
        declared.length === 0
          ? `"${node.type}" has no branches, but the fragment has branch "${key}"`
          : `"${node.type}" has no branch "${key}"`,
        formatPath([...path, key]),
        { branches: declared },
      );
    }
  }
}

/** Sets `obj[key]` as an own property, so `__proto__` is a plain key, never the prototype. */
function ownSet<T>(obj: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Pass 2: the steps, with placeholders resolved now that every ID of the batch exists. */
function materialize(b: Build, pending: Pending[]): Step[] {
  return pending.map((p) => {
    const { frag } = p;
    const config: Record<string, ValueExpr> = {};
    for (const [key, v] of Object.entries(frag.config ?? {})) {
      // A paste never fails: a `steps.$x` no placeholder defines stays as is, for the validator.
      const value = b.verbatim
        ? resolveValuePlaceholders(v, b.ctx.placeholders, b.ctx.used).value
        : resolvedValue(b.ctx, v, formatPath([...p.path, "config", key]));
      ownSet(config, key, value);
    }
    let step: Step;
    if (b.verbatim || !p.node) {
      step = { id: p.id, type: frag.type, config };
    } else {
      const created = createStep(p.id, p.node);
      step = { ...created, config: { ...created.config, ...config } };
    }
    if (frag.name !== undefined) step = { ...step, name: frag.name };
    if (frag.disabled === true) step = { ...step, disabled: true };
    if (typeof frag.note === "string" && frag.note !== "") step = { ...step, note: frag.note };
    if (frag.color !== undefined) step = { ...step, color: frag.color };
    if (p.branches) {
      const branches: Record<string, Step[]> = {};
      for (const [key, list] of p.branches) ownSet(branches, key, materialize(b, list));
      step = { ...step, branches: { ...(step.branches ?? {}), ...branches } };
    }
    return b.verbatim || !p.node ? step : syncBranches(step, p.node);
  });
}

/** Builds `frags` for insertion into `doc` (IDs checked against it). */
function build(
  doc: WorkflowDoc,
  ctx: HandlerContext,
  frags: unknown,
  verbatim: boolean,
): { steps: Step[]; paths: Map<string, Path> } {
  const b: Build = { ctx, verbatim, taken: allStepIds(doc), paths: new Map() };
  const pending = plan(b, frags, ["steps"], true);
  return { steps: materialize(b, pending), paths: b.paths };
}

/**
 * A validator field path (`to`, `headers.replyTo`, `cc[1]`) as path segments. The field string
 * joins keys with `.` unescaped, so it is read against the config value itself: at each level
 * the longest own key the rest starts with wins, so keys holding `.` or `[` map back whole.
 */
function fieldSegments(field: string, config: Record<string, ValueExpr>): Path {
  const segs: Path = [];
  let cur: unknown = config;
  let i = 0;
  while (i < field.length) {
    if (segs.length > 0) {
      const index = /^\[(\d+)\]/.exec(field.slice(i));
      if (index) {
        const n = Number(index[1]);
        segs.push(n);
        cur = Array.isArray(cur) ? cur[n] : undefined;
        i += index[0].length;
        continue;
      }
      if (field.charAt(i) !== ".") break;
      i++;
    }
    const rest = field.slice(i);
    const keys = isObject(cur)
      ? Object.keys(cur).filter(
          (k) => rest === k || rest.startsWith(`${k}.`) || rest.startsWith(`${k}[`),
        )
      : [];
    keys.sort((a, z) => z.length - a.length);
    const key = keys[0] ?? /^[^.[]*/.exec(rest)?.[0] ?? rest;
    if (key === "") break;
    segs.push(key);
    cur = isObject(cur) && Object.hasOwn(cur, key) ? cur[key] : undefined;
    i += key.length;
  }
  return segs;
}

/**
 * The schema of the config field at `field` in `input` (refs into `$defs` resolved and the defs
 * carried along), or the whole input schema when the field isn't found.
 */
function fieldSchema(input: JSONSchema, field: Path | undefined): JSONSchema {
  /** The schema at `path`, or `undefined` when missing or empty (any). */
  const at = (path: Path): JSONSchema | undefined => {
    const sub = schemaAtPath(input, path);
    if (!sub) return undefined;
    const resolved = derefSchema(input, sub);
    const { $defs: _, definitions: __, ...own } = resolved;
    return Object.keys(own).length === 0 ? undefined : carryDefs(input, resolved);
  };
  if (!field || field.length === 0) return input;
  const direct = at(field);
  if (direct) return direct;
  // Under a union (`anyOf` of objects), a property path gives any: use the one member schema
  // declaring the property, else the deepest ancestor with a schema.
  for (let n = field.length - 1; n >= 0; n--) {
    const parent = n === 0 ? input : at(field.slice(0, n));
    if (!parent) continue;
    const seg = field[n];
    const members = (parent.anyOf ?? parent.oneOf) as unknown;
    if (n === field.length - 1 && typeof seg === "string" && Array.isArray(members)) {
      const props = members.flatMap((m) => {
        const s = derefSchema(input, m as JSONSchema).properties as Record<string, unknown>;
        return s && Object.hasOwn(s, seg) ? [s[seg] as JSONSchema] : [];
      });
      if (props.length === 1) return carryDefs(input, derefSchema(input, props[0] as JSONSchema));
    }
    return parent;
  }
  return input;
}

/**
 * Validates `cand` once and throws on the first issue on an inserted step (normal mode) whose
 * code is on the reject list, at the fragment path it maps to.
 */
function gate(cand: WorkflowDoc, ctx: HandlerContext, paths: Map<string, Path>): void {
  for (const issue of validateWorkflow(cand, ctx.manifest)) {
    if (issue.stepId === undefined || !REJECTED.has(issue.code)) continue;
    const at = paths.get(issue.stepId);
    if (!at) continue;
    const step = findStep(cand, issue.stepId)?.step as Step;
    const code = issue.code as CommandErrorCode;
    let path: Path = at;
    let hint: unknown;
    const field = issue.field !== undefined ? fieldSegments(issue.field, step.config) : undefined;
    const node = ctx.nodes.get(step.type);
    if (code === "node.unknown") path = [...at, "type"];
    else if (code === "step.invalidId" || code === "step.duplicateId") path = [...at, "id"];
    else if (code === "branch.unknown") {
      const declared = node ? branchesFor(node, step).map((x) => x.id) : [];
      const key = Object.keys(step.branches ?? {}).find((k) => !declared.includes(k));
      path = key === undefined ? [...at, "branches"] : [...at, "branches", key];
      hint = { branches: declared };
    } else if (field) path = [...at, "config", ...field];
    if (code.startsWith("ref.")) {
      hint = { refs: availableRefs(cand, ctx.manifest, { stepId: step.id }).refs };
    } else if (code === "config.invalid" && node) {
      hint = { expected: fitSchemaHint(compactSchema(fieldSchema(node.input, field))) };
    }
    throw new CommandFailure(code, issue.message, formatPath(path), hint);
  }
}

/** `doc` with `run` (top-level inserted IDs, one list) wrapped in the section `input`. */
function wrapInSection(doc: WorkflowDoc, input: SectionInput, run: string[]): WorkflowDoc {
  const first = run[0] as string;
  const last = run[run.length - 1] as string;
  const sections = doc.sections ?? [];
  const hit = overlapping(doc, sections, first, last);
  if (hit >= 0) throw overlapFailure(first, last, sections[hit] as Section, "section");
  const id = newSectionId(doc, input.id, input.title, "section.id");
  const section: Section = {
    id,
    title: String(input.title),
    color: input.color,
    ...(input.note !== undefined && input.note !== "" ? { note: input.note } : {}),
    first,
    last,
  };
  return withSections(doc, [...sections, section]);
}

const insertSteps: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"insertSteps">;
  const verbatim = cmd.verbatim === true;
  if (cmd.section !== undefined) {
    if (!isObject(cmd.section)) {
      throw new CommandFailure("command.invalid", "section must be an object", "section");
    }
    checkColor(cmd.section.color, "section.color");
    checkNote(cmd.section.note, "section.note");
  }
  const { doc: placed, loc } = locate(doc, ctx, cmd.at, "at");
  const { steps, paths } = build(placed, ctx, cmd.steps, verbatim);
  let cand = insertStepRun(placed, loc, steps);
  if (!verbatim) gate(cand, ctx, paths);
  if (cmd.section !== undefined) {
    cand = wrapInSection(
      cand,
      cmd.section,
      steps.map((s) => s.id),
    );
  }
  return { doc: cand, created: (steps[0] as Step).id };
};

const replaceSteps: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"replaceSteps">;
  const run = stepRun(doc, ctx, cmd.first, cmd.last, { first: "first", last: "last" });
  const { parentId, branch, index } = run.location;
  const list =
    parentId === null
      ? doc.steps
      : (branchList(findStep(doc, parentId)?.step as Step, branch as string) ?? []);
  const replacedSteps = list.slice(index, run.end + 1);
  const replaced = replacedSteps.map((s) => s.id);
  /** Every step inside the replaced steps' subtrees (not the replaced steps themselves). */
  const inner = new Set<string>();
  const collect = (s: Step) => {
    for (const l of Object.values(s.branches ?? {})) {
      for (const c of l) {
        inner.add(c.id);
        collect(c);
      }
    }
  };
  for (const s of replacedSteps) collect(s);
  let cut = doc;
  for (const id of replaced) cut = removeStep(cut, id);
  // Sections are upkept once below, from `doc`: undo what each removal's upkeep did.
  const { sections: _, ...rest } = cut;
  const removed: WorkflowDoc =
    doc.sections !== undefined ? { ...rest, sections: doc.sections } : rest;
  const { steps, paths } = build(removed, ctx, cmd.steps, false);
  const loc: StepLocation = { parentId, ...(branch !== undefined ? { branch } : {}), index };
  const inserted = insertStepRun(removed, loc, steps);
  const top = steps.map((s) => s.id);
  const cand = replacedSections(doc, inserted, {
    run: { parentId, branch, start: index, end: run.end },
    replaced,
    inner,
    top,
  });
  gate(cand, ctx, paths);
  if (jsonEqual(cand, doc)) return { doc, created: top[0] as string };
  return { doc: cand, created: top[0] as string };
};

/**
 * `after`'s sections for a `replaceSteps` of `doc`, each upkept on its own from `doc`:
 * - a section holding the whole run holds the new top-level steps in its place;
 * - any other section loses the replaced steps (a section that held part of the run shrinks to
 *   its remaining members), so it never grows over the new steps;
 * - steps inside the replaced subtrees count as gone for every section, even when a new step
 *   reuses one's ID (a section nested in the run is removed).
 */
function replacedSections(
  doc: WorkflowDoc,
  after: WorkflowDoc,
  edit: {
    run: { parentId: string | null; branch: string | undefined; start: number; end: number };
    replaced: string[];
    inner: Set<string>;
    top: string[];
  },
): WorkflowDoc {
  const sections = doc.sections;
  if (!sections?.length) return after;
  const none: readonly string[] = [];
  const gone = new Map<string, readonly string[]>(
    [...edit.replaced, ...edit.inner].map((id) => [id, none]),
  );
  const holding = new Map(gone);
  for (const id of edit.replaced) holding.set(id, edit.top);
  const { run } = edit;
  let changed = false;
  const next: Section[] = [];
  for (const section of sections) {
    const r = sectionRun(doc, section);
    const holds =
      !!r &&
      r.parentId === run.parentId &&
      r.branch === run.branch &&
      r.start <= run.start &&
      r.end >= run.end;
    // `after.sections` is `doc.sections`: upkeep returns the section itself when it stays.
    const one = upkeepSections(
      { ...doc, sections: [section] },
      { ...after, sections: [section] },
      { subst: holds ? holding : gone },
    );
    const kept = one.sections?.[0];
    if (kept !== section) changed = true;
    if (kept) next.push(kept);
  }
  return changed ? withSections(after, next) : after;
}

/** @internal The bulk-add handlers by op. */
export const fragmentHandlers: Record<string, Handler> = { insertSteps, replaceSteps };
