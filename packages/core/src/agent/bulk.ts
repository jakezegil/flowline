/**
 * Bulk edit and restructure: `duplicateSteps`, `updateSteps`, `replaceInConfig`, `moveSteps`,
 * `removeSteps`, `wrapSteps`, `unwrapStep`.
 *
 * Section upkeep: each handler edits the tree without touching `sections` (the one-pass removal
 * and update helpers here, plus the tree insertions), then upkeeps the sections once, from its
 * input doc (`upkeepSections(doc, after, effect)`). Upkeep rebuilds `sections` from `before`, so
 * a pre-edited `after.sections` would be lost or doubly applied. Selector edits can touch
 * thousands of steps, so they never run a tree operation per step (each one upkeeps the whole
 * doc).
 *
 * @module
 */
import { sectionRun, upkeepSections } from "../annotations";
import { branchesFor } from "../json-schema";
import { isRef, isTpl, parseTemplate, type TemplatePart } from "../refs";
import { copyName, createStep, syncBranches } from "../step-factory";
import {
  branchList,
  cloneRunWithFreshIds,
  FlowlineTreeError,
  generateStepId,
  insertStepRun,
  type StepLocation,
  walkSteps,
} from "../tree";
import type { Step, ValueExpr, WorkflowDoc } from "../types";
import { formatPath } from "./command-schema";
import {
  type Command,
  CommandFailure,
  type ConfigPatch,
  type Handler,
  type HandlerContext,
  type StepUpdate,
} from "./commands";
import type { Where } from "./read-types";
import { checkColor, checkNote, runSteps } from "./sections";
import { matchSteps } from "./selectors";
import {
  displayName,
  existingStep,
  isObject,
  locate,
  nodeOf,
  patchConfig,
  placeholderId,
  resolvedValue,
  subtree,
  unknownPlaceholder,
  wrongKind,
} from "./single";

type Cmd<Op extends Command["op"]> = Extract<Command, { op: Op }>;
type Path = (string | number)[];

/** `path` (a formatted relative path) under `prefix` segments. */
function under(prefix: Path, path: string): string {
  const head = formatPath(prefix);
  if (head === "") return path;
  if (path === "") return head;
  return `${head}${path.startsWith("[") ? "" : "."}${path}`;
}

/** Runs `fn`, moving a {@link CommandFailure}'s path under `prefix`. */
function nested<T>(prefix: Path, fn: () => T): T {
  if (prefix.length === 0) return fn();
  try {
    return fn();
  } catch (e) {
    if (e instanceof CommandFailure) {
      throw new CommandFailure(e.code, e.message, under(prefix, e.path), e.hint);
    }
    throw e;
  }
}

/** Sets `obj[key]` as an own property, so `__proto__` is a plain key, never the prototype. */
function ownSet<T>(obj: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/** A command's run `first`…`last`: its location, end index and top-level steps. */
function runOf(doc: WorkflowDoc, ctx: HandlerContext, cmd: { first: string; last: string }) {
  return runSteps(doc, ctx, cmd.first, cmd.last, { first: "first", last: "last" });
}

/** A location without an `undefined` branch. */
function place(loc: StepLocation, index = loc.index): StepLocation {
  return {
    parentId: loc.parentId,
    ...(loc.branch !== undefined ? { branch: loc.branch } : {}),
    index,
  };
}

/** Whether two locations name the same list. */
function sameList(a: StepLocation, b: StepLocation): boolean {
  return a.parentId === b.parentId && (a.parentId === null || a.branch === b.branch);
}

/**
 * `doc` with `fn` applied to each step it maps (first pre-order occurrence of an ID), in one
 * pass: `fn` returns the new step, `null` to remove it (with its subtree), or the step itself to
 * keep it. A kept step's children are visited in `fn`'s result. Path-copying, like the tree
 * operations, and `sections` are left as they are (the caller upkeeps).
 */
function rebuild(
  doc: WorkflowDoc,
  targets: Iterable<string>,
  fn: (step: Step) => Step | null,
): WorkflowDoc {
  const left = new Set(targets);
  if (left.size === 0) return doc;
  const visit = (list: Step[]): Step[] => {
    let out: Step[] | undefined;
    list.forEach((step, i) => {
      let next: Step | null = step;
      if (left.size > 0 && left.has(step.id)) {
        left.delete(step.id);
        next = fn(step);
      }
      if (next?.branches && left.size > 0) {
        let branches: Record<string, Step[]> | undefined;
        for (const [key, branch] of Object.entries(next.branches)) {
          const updated = visit(branch);
          if (updated !== branch) {
            branches ??= { ...next.branches };
            ownSet(branches, key, updated);
          }
        }
        if (branches) next = { ...next, branches };
      }
      if (next !== step && !out) out = list.slice(0, i);
      if (out && next) out.push(next);
    });
    return out ?? list;
  };
  const steps = visit(doc.steps);
  return steps === doc.steps ? doc : { ...doc, steps };
}

/** `doc` without the steps `ids` (with their subtrees), `sections` untouched. */
function withoutSteps(doc: WorkflowDoc, ids: Iterable<string>): WorkflowDoc {
  return rebuild(doc, ids, () => null);
}

/** Of `ids`, the steps not inside another one's subtree, in pre-order (first occurrences). */
function outermost(doc: WorkflowDoc, ids: readonly string[]): string[] {
  const all = new Set(ids);
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (list: Step[], inside: boolean) => {
    for (const step of list) {
      const hit = !inside && all.has(step.id) && !seen.has(step.id);
      if (hit) {
        seen.add(step.id);
        out.push(step.id);
      }
      for (const branch of Object.values(step.branches ?? {})) visit(branch, inside || hit);
    }
  };
  visit(doc.steps, false);
  return out;
}

/**
 * The steps `where` matches (pre-order). `within.stepId` and `section` accept placeholders; a
 * missing step, branch or section fails at its path under `where`.
 */
function selected(doc: WorkflowDoc, ctx: HandlerContext, where: unknown): string[] {
  if (!isObject(where)) {
    throw new CommandFailure("command.invalid", "where must be an object", "where");
  }
  const resolved: Record<string, unknown> = { ...where };
  const within = where.within;
  if (isObject(within) && typeof within.stepId === "string") {
    const owner = existingStep(doc, ctx, within.stepId, "where.within.stepId");
    const branch = within.branch;
    if (branch !== undefined) {
      const node = ctx.nodes.get(owner.step.type);
      const declared = node ? branchesFor(node, owner.step).map((b) => b.id) : [];
      const held = Object.keys(owner.step.branches ?? {});
      if (typeof branch !== "string" || !(declared.includes(branch) || held.includes(branch))) {
        throw new CommandFailure(
          "branch.unknown",
          `Step "${owner.id}" has no branch "${String(branch)}"`,
          "where.within.branch",
          { branches: [...new Set([...declared, ...held])] },
        );
      }
    }
    resolved.within = { ...within, stepId: owner.id };
  }
  const section = where.section;
  if (typeof section === "string") {
    let id = section;
    const sections = doc.sections ?? [];
    if (section.startsWith("$")) {
      const real = ctx.sectionPlaceholders.get(section);
      if (real !== undefined) {
        ctx.used.set(section, real);
        id = real;
      } else if (ctx.placeholders.has(section)) {
        throw wrongKind(section, "step", "section", "where.section");
      } else if (!sections.some((s) => s.id === section)) {
        throw unknownPlaceholder(ctx, section, "where.section");
      }
    }
    if (!sections.some((s) => s.id === id)) {
      throw new CommandFailure("section.notFound", `Section "${id}" not found`, "where.section", {
        sections: [...new Set(sections.map((s) => s.id))],
      });
    }
    resolved.section = id;
  }
  try {
    return matchSteps(doc, ctx.manifest, resolved as Where);
  } catch (e) {
    if (e instanceof FlowlineTreeError) {
      throw new CommandFailure("command.invalid", e.message, "where");
    }
    throw e;
  }
}

/** How many matched IDs an `expect.mismatch` hint lists; the rest are counted in `more`. */
const MATCHED_MAX = 100;

/**
 * Throws `expect.mismatch` (hint `{ matched }`, plus `more` past {@link MATCHED_MAX} IDs) unless
 * `matched` has `expect` steps.
 */
function checkExpect(matched: string[], expect: unknown): void {
  if (typeof expect !== "number" || !Number.isInteger(expect) || expect < 0) {
    throw new CommandFailure(
      "command.invalid",
      "expect must be a non-negative integer: how many steps you expect to match",
      "expect",
    );
  }
  if (matched.length !== expect) {
    throw new CommandFailure(
      "expect.mismatch",
      `Expected ${expect} matching ${expect === 1 ? "step" : "steps"}, but ${matched.length} matched`,
      "expect",
      matched.length > MATCHED_MAX
        ? { matched: matched.slice(0, MATCHED_MAX), more: matched.length - MATCHED_MAX }
        : { matched },
    );
  }
}

const duplicateSteps: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"duplicateSteps">;
  const run = runOf(doc, ctx, cmd);
  const after = place(run.location, run.end + 1);
  const { doc: placed, loc } =
    cmd.at === undefined ? { doc, loc: after } : locate(doc, ctx, cmd.at, "at");
  const { steps: copies } = cloneRunWithFreshIds(placed, run.steps);
  const taken = new Set<string>();
  walkSteps(placed, (s) => taken.add(displayName(s, ctx)));
  const named = copies.map((copy) => {
    const name = copyName(displayName(copy, ctx), taken);
    taken.add(name);
    return { ...copy, name };
  });
  const inserted = insertStepRun(placed, loc, named);
  const ids = named.map((s) => s.id);
  // Copies right after `last` join a section `last` ends (or is inside).
  const joins = sameList(loc, after) && loc.index === after.index;
  const last = run.ids[run.ids.length - 1] as string;
  return {
    doc: upkeepSections(doc, inserted, joins ? { subst: new Map([[last, [last, ...ids]]]) } : {}),
    created: ids[0] as string,
  };
};

/** `step` with `set` and `config` applied (the same object when nothing changes). */
function updated(
  ctx: HandlerContext,
  step: Step,
  set: StepUpdate["set"] | undefined,
  config: ConfigPatch | undefined,
): Step {
  let next = step;
  if (set !== undefined) {
    if (!isObject(set)) throw new CommandFailure("command.invalid", "set must be an object", "set");
    if (set.name !== undefined) {
      if (typeof set.name !== "string") {
        throw new CommandFailure("command.invalid", "set.name must be a string", "set.name");
      }
      const name = set.name.trim();
      if ((next.name ?? "") !== name) {
        const { name: _, ...rest } = next;
        next = name === "" ? rest : { ...rest, name };
      }
    }
    if (set.disabled !== undefined) {
      if (typeof set.disabled !== "boolean") {
        throw new CommandFailure(
          "command.invalid",
          "set.disabled must be a boolean",
          "set.disabled",
        );
      }
      if ((next.disabled === true) !== set.disabled) {
        const { disabled: _, ...rest } = next;
        next = set.disabled ? { ...rest, disabled: true } : rest;
      }
    }
    if (set.note !== undefined) {
      checkNote(set.note, "set.note");
      const note = set.note ?? "";
      if ((next.note ?? "") !== note) {
        const { note: _, ...rest } = next;
        next = note === "" ? rest : { ...rest, note };
      }
    }
    if (set.color !== undefined) {
      if (set.color !== null) checkColor(set.color, "set.color");
      const color = set.color ?? undefined;
      if (next.color !== color) {
        const { color: _, ...rest } = next;
        next = color === undefined ? rest : { ...rest, color };
      }
    }
  }
  if (config !== undefined) {
    const patched = patchConfig(ctx, next.config, { config });
    if (patched !== undefined) next = withConfig(ctx, next, patched);
  }
  return next;
}

/** `step` with `config`, its branches synced to what its node declares for that config. */
function withConfig(ctx: HandlerContext, step: Step, config: Record<string, ValueExpr>): Step {
  const node = ctx.nodes.get(step.type);
  const next: Step = { ...step, config };
  return node ? syncBranches(next, node) : next;
}

const updateSteps: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"updateSteps">;
  if ("updates" in cmd) {
    if (!Array.isArray(cmd.updates)) {
      throw new CommandFailure("command.invalid", "updates must be an array", "updates");
    }
    let cur = doc;
    cmd.updates.forEach((u, k) => {
      nested(["updates", k], () => {
        if (!isObject(u)) throw new CommandFailure("command.invalid", "An update is an object", "");
        const { id, step } = existingStep(cur, ctx, u.id, "id");
        const next = updated(ctx, step, u.set, u.config);
        if (next !== step) cur = rebuild(cur, [id], () => next);
      });
    });
    return { doc: upkeepSections(doc, cur) };
  }
  const ids = selected(doc, ctx, cmd.where);
  checkExpect(ids, cmd.expect);
  const next = rebuild(doc, ids, (step) => updated(ctx, step, cmd.set, cmd.config));
  return { doc: upkeepSections(doc, next) };
};

/** `text` with every `find` replaced (the same string when there is none). */
function replaceText(text: string, find: string, replace: string): string {
  return text.includes(find) ? text.split(find).join(replace) : text;
}

/** Template parts with adjacent text merged and empty text dropped, as JSON for comparing. */
function partsKey(parts: TemplatePart[]): string {
  const out: TemplatePart[] = [];
  for (const part of parts) {
    const prev = out[out.length - 1];
    if ("text" in part) {
      if (part.text === "") continue;
      if (prev && "text" in prev) out[out.length - 1] = { text: prev.text + part.text };
      else out.push(part);
    } else {
      out.push(part);
    }
  }
  return JSON.stringify(out);
}

/** The raw `[start, end)` spans of `tpl`'s `{{ }}` refs, as {@link parseTemplate} reads them. */
function refSpans(tpl: string): [number, number][] {
  const spans: [number, number][] = [];
  let i = 0;
  while (i < tpl.length) {
    if (tpl.startsWith("\\{{", i)) {
      i += 3;
    } else if (tpl.startsWith("{{{", i)) {
      i++;
    } else if (tpl.startsWith("{{", i)) {
      const end = tpl.indexOf("}}", i + 2);
      if (end === -1) break;
      spans.push([i, end + 2]);
      i = end + 2;
    } else {
      i++;
    }
  }
  return spans;
}

/**
 * A template with `find` replaced in its literal text only, never in a `{{ }}` ref or an escape,
 * and never changing which refs it has. The raw text around the refs is edited in place when
 * that reads back right; otherwise the template is rewritten from its parts, with a `{{` in the
 * text escaped. When neither reads back to the intended parts, the template is left unchanged.
 */
function replaceInTemplate(tpl: string, find: string, replace: string): string {
  const parts = parseTemplate(tpl);
  const want = parts.map((p) => ("text" in p ? { text: replaceText(p.text, find, replace) } : p));
  const key = partsKey(want);
  if (key === partsKey(parts)) return tpl;
  let raw = "";
  let at = 0;
  for (const [start, end] of refSpans(tpl)) {
    raw += replaceText(tpl.slice(at, start), find, replace) + tpl.slice(start, end);
    at = end;
  }
  raw += replaceText(tpl.slice(at), find, replace);
  if (partsKey(parseTemplate(raw)) === key) return raw;
  const rebuilt = want
    .map((p) => ("text" in p ? p.text.replaceAll("{{", "\\{{") : `{{${p.ref}}}`))
    .join("");
  return partsKey(parseTemplate(rebuilt)) === key ? rebuilt : tpl;
}

/** `expr` with `find` replaced in strings and template text (the same value when unchanged). */
function replaceIn(expr: ValueExpr, find: string, replace: string): ValueExpr {
  if (typeof expr === "string") return replaceText(expr, find, replace);
  if (Array.isArray(expr)) {
    const next = expr.map((e) => replaceIn(e, find, replace));
    return next.some((e, i) => e !== expr[i]) ? next : expr;
  }
  if (isRef(expr)) return expr;
  if (isTpl(expr)) {
    const tpl = replaceInTemplate(expr.$tpl, find, replace);
    return tpl === expr.$tpl ? expr : { ...expr, $tpl: tpl };
  }
  if (isObject(expr)) {
    let changed = false;
    const next: Record<string, ValueExpr> = {};
    for (const [k, v] of Object.entries(expr)) {
      const r = replaceIn(v as ValueExpr, find, replace);
      if (r !== v) changed = true;
      ownSet(next, k, r);
    }
    return changed ? next : expr;
  }
  return expr;
}

const replaceInConfig: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"replaceInConfig">;
  if (typeof cmd.find !== "string" || cmd.find === "") {
    throw new CommandFailure("command.invalid", "find must be a non-empty string", "find");
  }
  if (typeof cmd.replace !== "string") {
    throw new CommandFailure("command.invalid", "replace must be a string", "replace");
  }
  const candidates = new Set<string>();
  if (cmd.where !== undefined) {
    for (const id of selected(doc, ctx, cmd.where)) candidates.add(id);
  }
  const changes = new Map<string, Record<string, ValueExpr>>();
  walkSteps(doc, (step) => {
    if (changes.has(step.id) || (cmd.where !== undefined && !candidates.has(step.id))) return;
    const config = replaceIn(step.config, cmd.find, cmd.replace) as Record<string, ValueExpr>;
    if (config !== step.config) changes.set(step.id, config);
  });
  checkExpect([...changes.keys()], cmd.expect);
  const next = rebuild(doc, changes.keys(), (step) =>
    withConfig(ctx, step, changes.get(step.id) as Record<string, ValueExpr>),
  );
  return { doc: upkeepSections(doc, next) };
};

const moveSteps: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"moveSteps">;
  const run = runOf(doc, ctx, cmd);
  const first = run.ids[0] as string;
  const last = run.ids[run.ids.length - 1] as string;
  const to = cmd.to as unknown;
  // Right after the run or right before it: where it already is.
  if (isObject(to) && (to.after !== undefined || to.before !== undefined)) {
    const key = to.after !== undefined ? "after" : "before";
    const anchor = placeholderId(ctx, to[key] as string, `to.${key}`);
    if (anchor === (key === "after" ? last : first)) return { doc };
  }
  const inside = new Set<string>();
  for (const s of run.steps) subtree(s, inside);
  // Check the anchor on the full doc (and create a declared branch the owner lacks), then
  // resolve it against the doc without the run.
  const { doc: prepared } = locate(doc, ctx, cmd.to, "to", inside);
  const removed = withoutSteps(prepared, run.ids);
  const { loc } = locate(removed, ctx, cmd.to, "to", inside);
  if (sameList(loc, run.location) && loc.index === run.location.index) return { doc };
  const moved = insertStepRun(removed, loc, run.steps);
  return { doc: upkeepSections(doc, moved, { moved: new Set(run.ids) }) };
};

const removeSteps: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"removeSteps">;
  let ids: string[];
  if ("ids" in cmd) {
    if (!Array.isArray(cmd.ids)) {
      throw new CommandFailure("command.invalid", "ids must be an array of step IDs", "ids");
    }
    ids = cmd.ids.map((ref, k) => existingStep(doc, ctx, ref, formatPath(["ids", k])).id);
  } else if ("where" in cmd) {
    ids = selected(doc, ctx, cmd.where);
    checkExpect(ids, cmd.expect);
  } else {
    ids = runOf(doc, ctx, cmd).ids;
  }
  return { doc: upkeepSections(doc, withoutSteps(doc, outermost(doc, ids))) };
};

const wrapSteps: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"wrapSteps">;
  const run = runOf(doc, ctx, cmd);
  const spec = cmd.in as unknown;
  if (!isObject(spec)) {
    throw new CommandFailure("command.invalid", "in must be { type, branch, config? }", "in");
  }
  const node = nodeOf(ctx, spec.type, "in.type");
  if (spec.config !== undefined && !isObject(spec.config)) {
    throw new CommandFailure("command.invalid", "config must be an object", "in.config");
  }
  const id = generateStepId(doc, node.type);
  const created = createStep(id, node);
  // Merged over the defaults, as addStep's config; `null` removes a key (a default too).
  const config: Record<string, ValueExpr> = { ...created.config };
  for (const [key, value] of Object.entries(spec.config ?? {})) {
    if (value === null) delete config[key];
    else
      ownSet(
        config,
        key,
        resolvedValue(ctx, value as ValueExpr, formatPath(["in", "config", key])),
      );
  }
  const base = syncBranches({ ...created, config }, node);
  const declared = branchesFor(node, base).map((b) => b.id);
  const branch = spec.branch;
  if (typeof branch !== "string" || !declared.includes(branch)) {
    throw new CommandFailure(
      "branch.unknown",
      declared.length === 0
        ? `"${node.type}" has no branches to wrap steps in`
        : `"${node.type}" has no branch "${String(branch)}"`,
      "in.branch",
      { branches: declared },
    );
  }
  const branches = new Map(Object.entries(base.branches ?? {}));
  branches.set(branch, run.steps);
  const wrapper: Step = { ...base, branches: Object.fromEntries(branches) };
  const removed = withoutSteps(doc, run.ids);
  const wrapped = insertStepRun(removed, place(run.location), [wrapper]);
  return { doc: upkeepSections(doc, wrapped, { subst: wrapSubst(doc, run, id) }), created: id };
};

/**
 * The upkeep substitution for wrapping `run` in `wrapperId`. Of the sections in the run's list
 * that overlap it but aren't strictly inside it, the first (by position) holds the wrapper: its
 * run members become the wrapper. Any later such section just loses its run members, so it
 * shrinks rather than overlapping the first. A section strictly inside the run moves into the
 * branch unchanged. (Sections in one list don't overlap, so a member is in one section at most.)
 */
function wrapSubst(
  doc: WorkflowDoc,
  run: { location: StepLocation; end: number; ids: string[] },
  wrapperId: string,
): Map<string, string[]> {
  const start = run.location.index;
  const inner = new Set<string>();
  const leaving = new Set<string>();
  let holder = Number.POSITIVE_INFINITY;
  const touching: { start: number; ids: string[] }[] = [];
  for (const section of doc.sections ?? []) {
    const r = sectionRun(doc, section);
    if (!r || r.parentId !== run.location.parentId || r.branch !== run.location.branch) continue;
    if (r.start > run.end || r.end < start) continue;
    const within = r.start >= start && r.end <= run.end;
    const equal = r.start === start && r.end === run.end;
    if (within && !equal) {
      for (const id of r.ids) inner.add(id);
    } else {
      touching.push({ start: r.start, ids: r.ids });
      holder = Math.min(holder, r.start);
    }
  }
  for (const t of touching) {
    if (t.start !== holder) for (const id of t.ids) leaving.add(id);
  }
  const subst = new Map<string, string[]>();
  for (const id of run.ids) {
    if (inner.has(id)) continue;
    subst.set(id, leaving.has(id) ? [] : [wrapperId]);
  }
  return subst;
}

const unwrapStep: Handler = (doc, command, ctx) => {
  const cmd = command as Cmd<"unwrapStep">;
  const { id, step, location } = existingStep(doc, ctx, cmd.id, "id");
  const held = Object.keys(step.branches ?? {});
  if (held.length === 0) {
    throw new CommandFailure("command.invalid", `Step "${id}" has no branches to unwrap`, "id", {
      expected: "a step with branches",
    });
  }
  const kept = typeof cmd.keep === "string" ? branchList(step, cmd.keep) : undefined;
  if (!kept) {
    throw new CommandFailure(
      "branch.unknown",
      `Step "${id}" has no branch "${String(cmd.keep)}"`,
      "keep",
      { branches: held },
    );
  }
  const removed = withoutSteps(doc, [id]);
  const lifted = insertStepRun(removed, place(location), kept);
  const keptIds = kept.map((s) => s.id);
  // The lifted steps count as moved and a section holding the unwrapped step stays put, so a
  // lifted section that now overlaps an outer one is the one dropped (upkeep rule 4), whatever
  // the order of `sections`.
  return {
    doc: upkeepSections(doc, lifted, {
      subst: new Map([[id, keptIds]]),
      moved: new Set(keptIds),
      anchored: new Set([id]),
    }),
  };
};

/** @internal The bulk edit and restructure handlers by op. */
export const bulkHandlers: Record<string, Handler> = {
  duplicateSteps,
  updateSteps,
  replaceInConfig,
  moveSteps,
  removeSteps,
  wrapSteps,
  unwrapStep,
};
