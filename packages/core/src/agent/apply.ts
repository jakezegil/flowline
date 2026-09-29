/**
 * `apply`: runs a batch of commands on a workflow doc atomically, and reports what changed.
 *
 * @module
 */
import { FlowlineTreeError, walkSteps } from "../tree";
import type { Manifest, NodeManifest, Section, Step, WorkflowDoc } from "../types";
import { type Issue, validateWorkflow } from "../validate";
import { formatPath, shapeErrors } from "./command-schema";
import {
  type ApplyError,
  type ApplyOptions,
  type ApplyResult,
  type Command,
  CommandFailure,
  type Handler,
  type HandlerContext,
} from "./commands";
import { formatCall, shownColor, shownLabel, stepLine } from "./format";
import { sectionHandlers } from "./sections";
import { AT_HINT, singleHandlers } from "./single";

/** Thrown by wrappers (the editor store) that turn a failed ApplyResult into an exception. */
export class FlowlineCommandError extends FlowlineTreeError {
  override readonly name: string = "FlowlineCommandError";
  /** @param error The failed batch's error; it is also the message. */
  constructor(readonly error: ApplyError) {
    super(error.message);
  }
}

/** Every command handler by op. */
const HANDLERS: Record<string, Handler> = { ...singleHandlers, ...sectionHandlers };

/** How many shape errors a failed result carries besides the first. */
const MORE_ERRORS = 9;
/** How many added issues a result lists. */
const ADDED_MAX = 20;
/** The longest `changed` is, in characters. */
const CHANGED_MAX = 2000;
/** The longest the ID list in `changed`'s `getSteps` marker is, in characters. */
const MARKER_IDS_MAX = 300;

const nodeIndex = new WeakMap<Manifest, Map<string, NodeManifest>>();
function nodesOf(manifest: Manifest): Map<string, NodeManifest> {
  let nodes = nodeIndex.get(manifest);
  if (!nodes) {
    nodes = new Map(manifest.nodes.map((n) => [n.type, n]));
    nodeIndex.set(manifest, nodes);
  }
  return nodes;
}

/**
 * Runs `commands` on `doc` in order, atomically: the first failing command fails the batch and
 * nothing is applied. The input doc is never mutated.
 *
 * - Unless `trusted`, every command's shape is checked first; `error` is the first shape error
 *   and `more` holds up to 9 others.
 * - `$n` (1-based) names the step `commands[n-1]` created, in step arguments and in
 *   `steps.$n…` refs and templates; `ids` maps each placeholder to the real ID.
 * - Unless `report: false`, the result has the outline of what changed and the validation issues
 *   the batch added and cleared.
 * - When nothing changes, `doc` is the input doc itself.
 *
 * @example
 * apply(doc, [
 *   { op: "addStep", at: { after: "getDeal" }, type: "crm.sendEmail" },
 *   { op: "setConfig", id: "$1", key: "to", value: { $ref: "steps.getDeal.deal.ownerId" } },
 * ], manifest)
 */
export function apply(
  doc: WorkflowDoc,
  commands: Command[],
  manifest: Manifest,
  opts: ApplyOptions = {},
): ApplyResult {
  if (!Array.isArray(commands)) {
    return {
      ok: false,
      error: {
        index: -1,
        path: "commands",
        code: "command.invalid",
        message: "commands must be an array of commands",
      },
    };
  }
  if (opts.trusted !== true) {
    const errors: ApplyError[] = [];
    for (let i = 0; i < commands.length && errors.length <= MORE_ERRORS; i++) {
      errors.push(...shapeErrors(manifest, commands[i], i));
    }
    const [first, ...rest] = errors;
    if (first) {
      return rest.length > 0
        ? { ok: false, error: first, more: rest.slice(0, MORE_ERRORS) }
        : { ok: false, error: first };
    }
  }

  const ctx: HandlerContext = {
    manifest,
    nodes: nodesOf(manifest),
    index: 0,
    placeholders: new Map(),
    used: new Map(),
    renamed: new Map(),
  };
  let cur = doc;
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i] as Command;
    ctx.index = i;
    const op = (cmd as { op?: unknown } | null)?.op;
    const handler =
      typeof op === "string" && Object.hasOwn(HANDLERS, op) ? HANDLERS[op] : undefined;
    if (!handler) {
      return {
        ok: false,
        error: {
          index: i,
          path: `commands[${i}].op`,
          code: "command.invalid",
          message: `Unknown op ${JSON.stringify(op)}`,
        },
      };
    }
    try {
      const r = handler(cur, cmd, ctx);
      cur = r.doc;
      if (r.created !== undefined) {
        ctx.placeholders.set(`$${i + 1}`, r.created);
        ctx.used.set(`$${i + 1}`, r.created);
      }
    } catch (e) {
      if (e instanceof CommandFailure) {
        // `e.path` is a formatted relative path (`id`, `config["a.[b"]`): join, never rewrite.
        const head = formatPath(["commands", i]);
        const path = e.path === "" ? head : `${head}${e.path.startsWith("[") ? "" : "."}${e.path}`;
        return {
          ok: false,
          error: {
            index: i,
            path,
            code: e.code,
            message: e.message,
            ...(e.hint !== undefined ? { hint: e.hint } : {}),
          },
        };
      }
      if (e instanceof FlowlineTreeError) {
        return {
          ok: false,
          error: {
            index: i,
            path: `commands[${i}]`,
            code: "location.invalid",
            message: e.message,
            hint: AT_HINT,
          },
        };
      }
      throw e;
    }
  }

  const ids = Object.fromEntries(ctx.used);
  const renamed = Object.fromEntries(ctx.renamed);
  if (opts.report === false || cur === doc) {
    return { ok: true, doc: cur, ids, renamed, changed: "", issues: { added: [], cleared: [] } };
  }
  const before = validateWorkflow(doc, manifest, opts.ctx);
  const after = validateWorkflow(cur, manifest, opts.ctx);
  const { added, cleared } = issueDelta(before, after);
  const issues: Extract<ApplyResult, { ok: true }>["issues"] = {
    added: added.slice(0, ADDED_MAX),
    cleared,
  };
  if (added.length > ADDED_MAX) {
    issues.more = { added: added.length - ADDED_MAX, fetch: { tool: "getIssues", args: {} } };
  }
  const changed = changedOutline(doc, cur, changedStepIds(doc, cur), after, manifest);
  return { ok: true, doc: cur, ids, renamed, changed, issues };
}

function issueKey(i: Issue): string {
  return JSON.stringify([i.code, i.stepId, i.sectionId, i.field, i.message]);
}

/** Issues in `after` but not `before` (added) and the reverse (cleared), as multisets. */
function issueDelta(before: Issue[], after: Issue[]): { added: Issue[]; cleared: Issue[] } {
  const diff = (from: Issue[], minus: Issue[]) => {
    const counts = new Map<string, number>();
    for (const i of minus) counts.set(issueKey(i), (counts.get(issueKey(i)) ?? 0) + 1);
    return from.filter((i) => {
      const k = issueKey(i);
      const n = counts.get(k) ?? 0;
      if (n === 0) return true;
      counts.set(k, n - 1);
      return false;
    });
  };
  return { added: diff(after, before), cleared: diff(before, after) };
}

/** Each step's first pre-order occurrence: the step, its list key and its index there. */
function indexSteps(doc: WorkflowDoc): Map<string, { step: Step; list: string; index: number }> {
  const out = new Map<string, { step: Step; list: string; index: number }>();
  walkSteps(doc, (step, loc) => {
    if (!out.has(step.id)) {
      out.set(step.id, {
        step,
        list: JSON.stringify([loc.parentId, loc.branch ?? null]),
        index: loc.index,
      });
    }
  });
  return out;
}

/** A step's own fields, without its branches. */
function ownFields(step: Step): string {
  const { branches: _, ...own } = step;
  return JSON.stringify(own);
}

/**
 * The positions in `seq` of a longest strictly increasing subsequence: the steps that kept their
 * relative order in a list.
 */
function increasingRun(seq: number[]): Set<number> {
  const tails: number[] = [];
  const prev: number[] = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    const v = seq[i] as number;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((seq[tails[mid] as number] as number) < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1] as number;
    tails[lo] = i;
  }
  const keep = new Set<number>();
  let k = tails.length > 0 ? (tails[tails.length - 1] as number) : -1;
  while (k >= 0) {
    keep.add(k);
    k = prev[k] as number;
  }
  return keep;
}

/**
 * Steps added, removed, or whose own fields (not branches) changed, plus sections
 * added/removed/changed. A step that moved (to another list, or out of order within its list)
 * counts as updated; a parent is not updated just because a child changed. Lists are in
 * pre-order (`removed` in `before`'s).
 *
 * @example
 * changedStepIds(before, after) // { added: ["sendEmail"], updated: [], removed: [], sections: {…} }
 */
export function changedStepIds(
  before: WorkflowDoc,
  after: WorkflowDoc,
): {
  added: string[];
  updated: string[];
  removed: string[];
  sections: { added: string[]; updated: string[]; removed: string[] };
} {
  const sectionsDelta = () => {
    const was = new Map((before.sections ?? []).map((s) => [s.id, s]));
    const now = new Map((after.sections ?? []).map((s) => [s.id, s]));
    const added: string[] = [];
    const updated: string[] = [];
    for (const [id, s] of now) {
      const old = was.get(id);
      if (!old) added.push(id);
      else if (old !== s && JSON.stringify(old) !== JSON.stringify(s)) updated.push(id);
    }
    const removed = [...was.keys()].filter((id) => !now.has(id));
    return { added, updated, removed };
  };
  if (before === after) {
    return {
      added: [],
      updated: [],
      removed: [],
      sections: { added: [], updated: [], removed: [] },
    };
  }
  const a = indexSteps(before);
  const b = indexSteps(after);
  const added: string[] = [];
  const updated = new Set<string>();
  const byList = new Map<string, { id: string; old: number }[]>();
  for (const [id, now] of b) {
    const was = a.get(id);
    if (!was) {
      added.push(id);
      continue;
    }
    if (was.step !== now.step && ownFields(was.step) !== ownFields(now.step)) updated.add(id);
    if (was.list !== now.list) {
      updated.add(id);
      continue;
    }
    let list = byList.get(now.list);
    if (!list) {
      list = [];
      byList.set(now.list, list);
    }
    list.push({ id, old: was.index });
  }
  // Within a list, steps outside the longest run that kept its order moved.
  for (const list of byList.values()) {
    const keep = increasingRun(list.map((e) => e.old));
    list.forEach((e, i) => {
      if (!keep.has(i)) updated.add(e.id);
    });
  }
  const removed = [...a.keys()].filter((id) => !b.has(id));
  return {
    added,
    updated: [...b.keys()].filter((id) => updated.has(id)),
    removed,
    sections: sectionsDelta(),
  };
}

/** One section line, as the outline shows it. */
function sectionLine(section: Section): string {
  const title = shownLabel(String(section.title ?? ""));
  return `▣ section ${String(section.id)} ${JSON.stringify(title)} [${shownColor(section.color)}]`;
}

/**
 * `changed`: a `+`/`~` line per added/updated step and section in `after`'s pre-order (a
 * section just before its first step), then `- <id>` per removed step and `- ▣ <id>` per removed
 * section. A changed workflow name, trigger or output mapping leads with `~ workflow "<name>"`,
 * `~ trigger <type>`, `~ output` (`- output` when removed). Cut to {@link CHANGED_MAX} with a
 * `getSteps` marker for the steps left out.
 */
function changedOutline(
  before: WorkflowDoc,
  after: WorkflowDoc,
  delta: ReturnType<typeof changedStepIds>,
  issues: Issue[],
  manifest: Manifest,
): string {
  const nodes = nodesOf(manifest);
  const counts = new Map<string, number>();
  for (const i of issues) {
    if (i.stepId !== undefined) counts.set(i.stepId, (counts.get(i.stepId) ?? 0) + 1);
  }
  const addedSteps = new Set(delta.added);
  const updatedSteps = new Set(delta.updated);
  const sectionMark = new Map<string, string>();
  for (const id of delta.sections.added) sectionMark.set(id, "+");
  for (const id of delta.sections.updated) sectionMark.set(id, "~");
  const sectionsAt = new Map<string, Section[]>();
  const leftover: Section[] = [];
  for (const s of after.sections ?? []) {
    if (!sectionMark.has(s.id)) continue;
    const list = sectionsAt.get(s.first);
    if (list) list.push(s);
    else sectionsAt.set(s.first, [s]);
  }
  const lines: { text: string; kind: "doc" | "step" | "removed" | "section"; stepId?: string }[] =
    [];
  const differs = (a: unknown, b: unknown) => a !== b && JSON.stringify(a) !== JSON.stringify(b);
  if (before.name !== after.name) {
    lines.push({
      text: `~ workflow ${JSON.stringify(shownLabel(String(after.name)))}`,
      kind: "doc",
    });
  }
  if (differs(before.trigger, after.trigger)) {
    lines.push({ text: `~ trigger ${shownLabel(String(after.trigger?.type))}`, kind: "doc" });
  }
  if (differs(before.output, after.output)) {
    lines.push({ text: after.output ? "~ output" : "- output", kind: "doc" });
  }
  const seen = new Set<string>();
  walkSteps(after, (step) => {
    if (seen.has(step.id)) return;
    seen.add(step.id);
    for (const s of sectionsAt.get(step.id) ?? []) {
      lines.push({ text: `${sectionMark.get(s.id)} ${sectionLine(s)}`, kind: "section" });
    }
    sectionsAt.delete(step.id);
    const mark = addedSteps.has(step.id) ? "+" : updatedSteps.has(step.id) ? "~" : undefined;
    if (mark) {
      const line = stepLine(step, nodes.get(step.type), counts.get(step.id) ?? 0, 120);
      lines.push({ text: `${mark} ${line}`, kind: "step", stepId: step.id });
    }
  });
  for (const list of sectionsAt.values()) leftover.push(...list);
  for (const s of leftover) {
    lines.push({ text: `${sectionMark.get(s.id)} ${sectionLine(s)}`, kind: "section" });
  }
  for (const id of delta.removed) lines.push({ text: `- ${id}`, kind: "removed" });
  for (const id of delta.sections.removed) lines.push({ text: `- ▣ ${id}`, kind: "section" });

  const whole = lines.map((l) => l.text).join("\n");
  if (whole.length <= CHANGED_MAX) return whole;

  // Keep the leading lines that fit beside the marker, which names the steps left out.
  const marker = (from: number) => {
    const rest = lines.slice(from);
    const ids = rest.flatMap((l) => (l.stepId ? [l.stepId] : []));
    const shown: string[] = [];
    let len = 0;
    for (const id of ids) {
      const add = JSON.stringify(id).length + 1;
      if (len + add > MARKER_IDS_MAX) break;
      shown.push(id);
      len += add;
    }
    const head = `… ${rest.length} more ${rest.length === 1 ? "change" : "changes"}`;
    const counts = (n: number, what: string) => (n > 0 ? [`${n} ${what}`] : []);
    const removed = rest.filter((l) => l.kind === "removed").length;
    const sections = rest.filter((l) => l.kind === "section").length;
    const unshown = ids.length - shown.length;
    const parts = [
      ...counts(unshown, unshown === 1 ? "step not listed" : "steps not listed"),
      ...counts(removed, removed === 1 ? "step removed" : "steps removed"),
      ...counts(sections, sections === 1 ? "section" : "sections"),
    ];
    const tail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    // Removed steps and section lines can't be fetched: no getSteps call without an ID to fetch.
    if (shown.length === 0) return `${head}${tail}`;
    return `${head}: ${formatCall({ tool: "getSteps", args: { ids: shown } })}${tail}`;
  };
  // The marker is at most ~450 chars: keep the lines that fit beside the largest one.
  const room = CHANGED_MAX - (MARKER_IDS_MAX + 150);
  const kept: string[] = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.text.length + 1 > room) break;
    kept.push(line.text);
    len += line.text.length + 1;
  }
  return [...kept, marker(kept.length)].join("\n");
}
