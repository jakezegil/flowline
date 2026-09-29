/**
 * `overview` and `outline`: a workflow as an indented outline, one line per step, kept within a
 * character budget by leaving content out in a fixed order, each omission with the exact call
 * that returns it.
 *
 * @module
 */
import { sectionRun } from "../annotations";
import { branchesFor } from "../json-schema";
import { FlowlineTreeError, findStep } from "../tree";
import type { Manifest, NodeManifest, Section, Step, TriggerManifest, WorkflowDoc } from "../types";
import { type Issue, validateWorkflow } from "../validate";
import {
  formatCall,
  noteSuffix,
  shownColor,
  shownLabel,
  shownLabelParts,
  stepLineParts,
} from "./format";
import type { FollowUp, Omission, OutlineResult, ReadArgs, ReadOptions, Where } from "./read-types";

/** Default budget of `overview` and `outline`, in characters. */
const DEFAULT_BUDGET = 4000;
/** Notes are cut to this many characters… */
const NOTE_MAX = 120;
/** …and to this many under budget pressure. */
const NOTE_MAX_TIGHT = 40;
/** A notes follow-up listing more IDs than this (as JSON) uses a selector instead. */
const NOTE_IDS_MAX = 400;

interface StepNode {
  step: Step;
  node: NodeManifest | undefined;
  issues: number;
  branches: BranchNode[];
  /** Steps in this step's subtree, itself included. */
  size: number;
  /** The step line last rendered, for reuse across renders. */
  line?: { noteMax: number; width: number; text: string; noteCut: boolean };
  /** Compact config JSON, `null` when the config is empty. Computed on first render. */
  config?: string | null;
}

interface BranchNode {
  parent: StepNode;
  id: string;
  label: string;
  list: ListNode;
  /** Depth of the branch's list (top level = 0). */
  depth: number;
  /** Pre-order position among all branches. */
  order: number;
  /** Steps in the branch's subtree. */
  size: number;
}

/** A section drawn as a header only: broken, or overlapping an earlier one. */
interface HeaderOnly {
  section: Section;
  suffix: string;
}

interface ListNode {
  steps: StepNode[];
  /** First shown index (for `outline({ after })`). */
  offset: number;
  /** The owning step and branch (absent for the top-level list and a one-step subtree). */
  parentId?: string;
  branch?: string;
  /** `outline` args that page this list. */
  base: { stepId?: string; branch?: string };
  /** Valid sections in this list, by run. */
  groups: { section: Section; start: number; end: number }[];
  /** Header-only sections, before a step index, or at the end (`-1`). */
  headers: Map<number, HeaderOnly[]>;
}

interface Model {
  doc: WorkflowDoc;
  /** Header lines, part of the floor. */
  header: string[];
  root: ListNode;
  branches: BranchNode[];
  /** `where` for the config and notes follow-ups. */
  scopeWhere: Where;
  /** For `outline({ stepId })`: the subtree's root step, which `scopeWhere` doesn't match. */
  subtreeRoot?: string;
  /** Sections whose steps are all missing, drawn at the end of the top-level list. */
  orphans: number;
  totals: OutlineResult["totals"];
}

interface RenderState {
  withConfig: boolean;
  noteMax: number;
  collapsed: Set<BranchNode>;
  /** Shown steps per list, counted from its offset. Absent: all. */
  kept: Map<ListNode, number>;
  /** Orphan sections: each as a header, folded into one line, or left out. */
  orphans: "shown" | "folded" | "hidden";
}

/** A pad wider than this is not used; a longer ID gets two spaces, overflowing its own line. */
const ID_PAD_MAX = 24;

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

function listKey(parentId: string | null, branch: string | undefined): string {
  return JSON.stringify([parentId, branch ?? null]);
}

/** `10s`, `5m`, `2h`, `1d`, else `1500ms`. */
function shortDuration(ms: number): string {
  const units: [number, string][] = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
    [1000, "s"],
  ];
  for (const [size, unit] of units) {
    if (ms > 0 && ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}

/** `trigger  <name> (<kind>[, <caption>])`. */
function triggerLine(doc: WorkflowDoc, manifest: Manifest): string {
  const t: TriggerManifest | undefined = manifest.triggers.find(
    (x) => x.type === doc.trigger?.type,
  );
  if (!t) return `trigger  ${shownLabel(String(doc.trigger?.type ?? ""))} (unknown)`;
  let caption: string | undefined;
  if (t.kind === "poll" && typeof t.interval === "number") {
    caption = `every ${shortDuration(t.interval)}`;
  } else if (t.kind === "event") {
    caption = t.events?.length ? t.events.join(", ") : t.event;
  } else if (t.kind === "schedule") {
    const cron = doc.trigger.config?.cron;
    caption = typeof cron === "string" && cron !== "" ? cron : undefined;
  }
  return `trigger  ${shownLabel(t.name)} (${t.kind}${caption ? `, ${shownLabel(caption)}` : ""})`;
}

/** Builds the render model for a list of steps and everything under it. */
function buildModel(
  doc: WorkflowDoc,
  manifest: Manifest,
  opts: ReadOptions,
  scope: {
    header: string[];
    subtreeRoot?: string;
    steps: Step[];
    offset: number;
    /** Key of the root list for sections, or `undefined` for a one-step subtree. */
    rootKey: string | undefined;
    parentId?: string;
    branch?: string;
    base: { stepId?: string; branch?: string };
    scopeWhere: Where;
    whole: boolean;
  },
): Model {
  const nodes = new Map(manifest.nodes.map((n) => [n.type, n]));
  const issues = validateWorkflow(doc, manifest, opts.ctx);
  const perStep = new Map<string, number>();
  for (const i of issues) {
    if (i.stepId !== undefined && i.sectionId === undefined) {
      perStep.set(i.stepId, (perStep.get(i.stepId) ?? 0) + 1);
    }
  }

  const lists = new Map<string, ListNode>();
  const branches: BranchNode[] = [];
  const inScope = new Set<string>();
  let notes = 0;
  let stepCount = 0;

  const makeList = (
    steps: Step[],
    depth: number,
    key: string | undefined,
    extra: Pick<ListNode, "parentId" | "branch" | "base">,
    offset = 0,
  ): ListNode => {
    const list: ListNode = { steps: [], offset, groups: [], headers: new Map(), ...extra };
    if (key !== undefined) lists.set(key, list);
    for (const step of steps) list.steps.push(makeStep(step, depth));
    return list;
  };

  const makeStep = (step: Step, depth: number): StepNode => {
    inScope.add(step.id);
    stepCount++;
    if (typeof step.note === "string" && step.note !== "") notes++;
    const node = nodes.get(step.type);
    const s: StepNode = {
      step,
      node,
      issues: perStep.get(step.id) ?? 0,
      branches: [],
      size: 1,
    };
    const ids = node ? branchesFor(node, step) : [];
    const all = [...ids];
    for (const id of Object.keys(step.branches ?? {})) {
      if (!all.some((b) => b.id === id)) all.push({ id, label: id });
    }
    for (const { id, label } of all) {
      const order = branches.length;
      const b: BranchNode = {
        parent: s,
        id,
        label,
        depth: depth + 1,
        order,
        size: 0,
        list: undefined as unknown as ListNode,
      };
      branches.push(b);
      b.list = makeList(step.branches?.[id] ?? [], depth + 1, listKey(step.id, id), {
        parentId: step.id,
        branch: id,
        base: { stepId: step.id, branch: id },
      });
      b.size = b.list.steps.reduce((n, x) => n + x.size, 0);
      s.branches.push(b);
      s.size += b.size;
    }
    return s;
  };

  const root = makeList(
    scope.steps,
    0,
    scope.rootKey,
    {
      ...(scope.parentId !== undefined ? { parentId: scope.parentId } : {}),
      ...(scope.branch !== undefined ? { branch: scope.branch } : {}),
      base: scope.base,
    },
    scope.offset,
  );

  // Sections: groups in their list, or header-only (broken, overlapping).
  let sectionCount = 0;
  const sections = Array.isArray(doc.sections) ? doc.sections : [];
  for (const section of sections) {
    const addHeader = (list: ListNode, at: number, suffix: string) => {
      const at_ = list.headers.get(at) ?? [];
      at_.push({ section, suffix });
      list.headers.set(at, at_);
    };
    const run = sectionRun(doc, section);
    let placed = false;
    if (run) {
      const list = lists.get(listKey(run.parentId, run.branch));
      if (list) {
        placed = true;
        const other = list.groups.find((g) => g.start <= run.end && run.start <= g.end);
        if (other) addHeader(list, run.start, ` (overlaps ${String(other.section.id)})`);
        else list.groups.push({ section, start: run.start, end: run.end });
      }
    } else {
      const anchor = findStep(doc, section.first) ?? findStep(doc, section.last);
      const list = anchor
        ? lists.get(listKey(anchor.location.parentId, anchor.location.branch))
        : undefined;
      if (anchor && list) {
        placed = true;
        addHeader(list, anchor.location.index, " (broken)");
      } else if (scope.whole) {
        placed = true;
        addHeader(root, -1, " (broken)");
      }
    }
    if (placed) {
      sectionCount++;
      if (typeof section.note === "string" && section.note !== "") notes++;
    }
  }
  for (const list of lists.values()) list.groups.sort((a, b) => a.start - b.start);

  const scoped = (i: Issue) => scope.whole || (i.stepId !== undefined && inScope.has(i.stepId));
  const counted = issues.filter(scoped);
  return {
    doc,
    header: scope.header,
    root,
    branches,
    scopeWhere: scope.scopeWhere,
    ...(scope.subtreeRoot !== undefined ? { subtreeRoot: scope.subtreeRoot } : {}),
    orphans: root.headers.get(-1)?.length ?? 0,
    totals: {
      steps: stepCount,
      sections: sectionCount,
      notes,
      errors: counted.filter((i) => i.severity === "error").length,
      warnings: counted.filter((i) => i.severity === "warning").length,
    },
  };
}

interface Rendered {
  lines: string[];
  omitted: Omission[];
  totals: OutlineResult["totals"];
  /** `resultSize` of the result, computed without joining the lines. */
  size: number;
  /** Lists drawn, in pre-order, with their shown step counts. */
  shown: { list: ListNode; count: number }[];
}

function toResult(r: Rendered): OutlineResult {
  return { text: r.lines.join("\n"), omitted: r.omitted, totals: r.totals };
}

function render(model: Model, state: RenderState): Rendered {
  const lines: string[] = [...model.header];
  const structural: Omission[] = [];
  const cutIds = new Set<string>();
  let cutCount = 0;
  /** Steps whose config line was left out, in render order. */
  const configIds: string[] = [];
  const shown: Rendered["shown"] = [];

  const noteCut = (id: string | undefined) => {
    cutCount++;
    if (id !== undefined) cutIds.add(id);
  };

  const sectionHeader = (section: Section, prefix: string, suffix: string) => {
    const note = noteSuffix(section.note, state.noteMax);
    const title = shownLabelParts(String(section.title ?? ""));
    const owner = findStep(model.doc, section.first) ? section.first : undefined;
    if (note.cut) noteCut(owner);
    if (title.cut) noteCut(owner);
    lines.push(
      `${prefix}▣ section ${String(section.id)} ${JSON.stringify(title.text)} [${shownColor(section.color)}]${suffix}${note.text}`,
    );
  };

  const renderStep = (s: StepNode, prefix: string, width: number) => {
    if (s.line?.noteMax !== state.noteMax || s.line.width !== width) {
      const parts = stepLineParts(s.step, s.node, s.issues, state.noteMax, width);
      s.line = { noteMax: state.noteMax, width, ...parts };
    }
    if (s.line.noteCut) noteCut(s.step.id);
    lines.push(prefix + s.line.text);
    if (s.config === undefined) {
      const c = s.step.config;
      s.config =
        typeof c === "object" && c !== null && Object.keys(c).length > 0 ? JSON.stringify(c) : null;
    }
    if (s.config !== null) {
      if (state.withConfig) lines.push(`${prefix}    config ${s.config}`);
      else configIds.push(s.step.id);
    }
    s.branches.forEach((b, i) => {
      const last = i === s.branches.length - 1;
      const glyph = last ? "└" : "├";
      if (state.collapsed.has(b)) {
        const fetch: FollowUp = { tool: "outline", args: { stepId: s.step.id, branch: b.id } };
        lines.push(
          `${prefix}  ${glyph} … ${plural(b.size, "step")} in branch ${b.id}: ${formatCall(fetch)}`,
        );
        structural.push({ what: "branch", stepId: s.step.id, branch: b.id, count: b.size, fetch });
        return;
      }
      let label = "";
      if (b.label.toLowerCase() !== b.id.toLowerCase()) {
        const l = shownLabelParts(b.label);
        if (l.cut) noteCut(s.step.id);
        label = ` “${l.text}”`;
      }
      lines.push(`${prefix}  ${glyph} ${b.id}${label}`);
      renderList(b.list, `${prefix}  ${last ? "   " : "│  "}`);
    });
  };

  const renderList = (list: ListNode, prefix: string) => {
    const total = list.steps.length - list.offset;
    const k = Math.min(state.kept.get(list) ?? total, total);
    const end = list.offset + k;
    shown.push({ list, count: k });
    let width = 0;
    for (let j = list.offset; j < end; j++) {
      const w = (list.steps[j] as StepNode).step.id.length + 2;
      if (w <= ID_PAD_MAX) width = Math.max(width, w);
    }
    const headersAt = (j: number, p: string) => {
      for (const h of list.headers.get(j) ?? []) sectionHeader(h.section, p, h.suffix);
    };
    let i = list.offset;
    while (i < end) {
      const g = list.groups.find((x) => x.start <= i && i <= x.end);
      if (g) {
        sectionHeader(g.section, prefix, "");
        const stop = Math.min(g.end, end - 1);
        for (let j = i; j <= stop; j++) {
          headersAt(j, `${prefix}  `);
          renderStep(list.steps[j] as StepNode, `${prefix}  `, width);
        }
        i = stop + 1;
      } else {
        headersAt(i, prefix);
        renderStep(list.steps[i] as StepNode, prefix, width);
        i++;
      }
    }
    if (k < total) {
      const hidden = list.steps.slice(end).reduce((n, x) => n + x.size, 0);
      const anchor = end > 0 ? (list.steps[end - 1] as StepNode).step.id : undefined;
      const fetch: FollowUp = {
        tool: "outline",
        args: { ...list.base, ...(anchor !== undefined ? { after: anchor } : {}) },
      };
      lines.push(
        anchor !== undefined
          ? `${prefix}… ${hidden} more ${hidden === 1 ? "step" : "steps"} after ${anchor}: ${formatCall(fetch)}`
          : `${prefix}… ${plural(hidden, "step")}: ${formatCall(fetch)}`,
      );
      structural.push({
        what: "steps",
        ...(list.parentId !== undefined ? { stepId: list.parentId } : {}),
        ...(list.branch !== undefined ? { branch: list.branch } : {}),
        count: hidden,
        fetch,
      });
    } else if (list !== model.root || state.orphans === "shown") {
      headersAt(-1, prefix);
    } else if (state.orphans === "folded" && model.orphans > 0) {
      const fetch: FollowUp = { tool: "getIssues", args: {} };
      const n = model.orphans;
      lines.push(
        `${prefix}⚠ ${plural(n, "section")} ${n === 1 ? "references" : "reference"} missing steps: ${formatCall(fetch)}`,
      );
      structural.push({ what: "sections", count: n, fetch });
    }
  };

  renderList(model.root, "");

  const omitted: Omission[] = [];
  if (configIds.length > 0) {
    const root = model.subtreeRoot;
    const fetches: { count: number; fetch: FollowUp }[] = [];
    if (root === undefined) {
      fetches.push({
        count: configIds.length,
        fetch: {
          tool: "getSteps",
          args: { where: model.scopeWhere, include: ["config"], limit: 50 },
        },
      });
    } else if (JSON.stringify(configIds).length <= NOTE_IDS_MAX) {
      // A subtree: `within` leaves out its root step, so name the steps.
      fetches.push({
        count: configIds.length,
        fetch: { tool: "getSteps", args: { ids: configIds, include: ["config"] } },
      });
    } else {
      const rootHidden = configIds[0] === root;
      if (rootHidden) {
        fetches.push({
          count: 1,
          fetch: { tool: "getSteps", args: { ids: [root], include: ["config"] } },
        });
      }
      fetches.push({
        count: configIds.length - (rootHidden ? 1 : 0),
        fetch: {
          tool: "getSteps",
          args: { where: model.scopeWhere, include: ["config"], limit: 50 },
        },
      });
    }
    for (const f of fetches) omitted.push({ what: "config", ...f });
    lines.push(`(config left out: ${fetches.map((f) => formatCall(f.fetch)).join(", ")})`);
  }
  if (cutCount > 0) {
    const ids = [...cutIds];
    const byIds = ids.length > 0 && JSON.stringify(ids).length <= NOTE_IDS_MAX;
    const fetch: FollowUp = byIds
      ? { tool: "getSteps", args: { ids, include: [], full: true } }
      : { tool: "getSteps", args: { where: model.scopeWhere, include: [], full: true, limit: 50 } };
    omitted.push({ what: "notes", count: cutCount, fetch });
  }
  omitted.push(...structural);

  const t = model.totals;
  lines.push(
    `— ${plural(t.steps, "step")} · ${plural(t.sections, "section")} · ${plural(t.notes, "note")} · ${plural(t.errors, "error")} · ${plural(t.warnings, "warning")}`,
  );
  let size = lines.length - 1 + JSON.stringify(omitted).length;
  for (const line of lines) size += line.length;
  return { lines, omitted, totals: t, size, shown };
}

/** Renders `model` within `budget`, leaving content out in the documented order. */
function fit(model: Model, budget: number | undefined): OutlineResult {
  const max = typeof budget === "number" && !Number.isNaN(budget) ? budget : DEFAULT_BUDGET;
  const state: RenderState = {
    withConfig: true,
    noteMax: NOTE_MAX,
    collapsed: new Set(),
    kept: new Map(),
    orphans: "shown",
  };
  const fits = (r: Rendered) => r.size <= max;

  // 1. Config.
  let r = render(model, state);
  if (fits(r)) return toResult(r);
  state.withConfig = false;
  r = render(model, state);
  if (fits(r)) return toResult(r);

  // 2. Notes.
  state.noteMax = NOTE_MAX_TIGHT;
  r = render(model, state);
  if (fits(r)) return toResult(r);

  // 3. Branches: deepest first, then the most steps, then the last in pre-order. A collapse that
  // doesn't make the result smaller (a marker can outweigh a one-step branch) is undone.
  const order = model.branches
    .filter((b) => b.size > 0)
    .sort((a, b) => b.depth - a.depth || b.size - a.size || b.order - a.order);
  for (const b of order) {
    state.collapsed.add(b);
    const tried = render(model, state);
    if (fits(tried)) return toResult(tried);
    if (tried.size < r.size) r = tried;
    else state.collapsed.delete(b);
  }

  // Sections whose steps are all missing fold into one line (their issues say more).
  if (model.orphans > 0) {
    state.orphans = "folded";
    const tried = render(model, state);
    if (fits(tried)) return toResult(tried);
    if (tried.size < r.size) r = tried;
    else state.orphans = "shown";
  }

  // 4. List tails: the longest shown list keeps as many steps as fit. Ends at the floor.
  for (;;) {
    let pick: { list: ListNode; count: number } | undefined;
    for (const x of r.shown) if (x.count > 0 && (!pick || x.count > pick.count)) pick = x;
    if (!pick) {
      // Nothing left to cut but orphan sections: leave them out (they stay in the totals).
      state.orphans = "hidden";
      return toResult(render(model, state));
    }
    const { list } = pick;
    let lo = 0;
    let hi = pick.count - 1;
    let best: Rendered | undefined;
    let bestK = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      state.kept.set(list, mid);
      const tried = render(model, state);
      if (fits(tried)) {
        best = tried;
        bestK = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (best) {
      state.kept.set(list, bestK);
      return toResult(best);
    }
    // 5. Nothing of this list fits: keep none, and go on to the next list (or the floor).
    state.kept.set(list, 0);
    r = render(model, state);
    if (fits(r)) return toResult(r);
  }
}

/**
 * The whole workflow as an outline: a `workflow "<name>"` line and the trigger line, then one
 * line per step (ID, node label, disabled, name, colour, issue count, note), sections as headers with their members indented under them,
 * branches as `├`/`└` headers, and a totals line.
 *
 * `budget` (characters, default 4000) covers `text` plus the serialized `omitted`. When it is
 * short, content is left out in this order: config lines, then notes (cut from 120 to 40
 * chars), then branches (deepest first), then sections whose steps are all missing (folded into
 * one line), then list tails (`outline({ after })` pages on). Each omission names the exact call
 * that returns what was left out. A result never exceeds `budget` once `budget` is at least the
 * floor (the header lines, one tail marker and totals); below it, the result is the floor.
 *
 * @example
 * const { text, omitted } = overview(doc, manifest, {});
 */
export function overview(
  doc: WorkflowDoc,
  manifest: Manifest,
  args: ReadArgs["overview"],
  opts: ReadOptions = {},
): OutlineResult {
  const model = buildModel(doc, manifest, opts, {
    header: [`workflow ${JSON.stringify(String(doc.name ?? ""))}`, triggerLine(doc, manifest)],
    steps: doc.steps,
    offset: 0,
    rootKey: listKey(null, undefined),
    base: {},
    scopeWhere: {},
    whole: true,
  });
  return fit(model, args.budget);
}

/**
 * Part of the workflow in the {@link overview} line format, with the same budget rules:
 * - `{ stepId }`: that step and its subtree;
 * - `{ stepId, branch }`: the steps of one branch;
 * - `{}`: the top-level steps.
 *
 * `after` pages the listed list (top level or branch): only the steps after that step are shown.
 * The first line is the call itself, e.g. `outline({stepId:"recheck",branch:"else"})`. Totals
 * cover the whole subtree or list. Throws a `FlowlineTreeError` for an unknown step or branch,
 * or an `after` that isn't in the list.
 */
export function outline(
  doc: WorkflowDoc,
  manifest: Manifest,
  args: ReadArgs["outline"],
  opts: ReadOptions = {},
): OutlineResult {
  const { stepId, branch, after } = args;
  const call = {
    ...(stepId !== undefined ? { stepId } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(after !== undefined ? { after } : {}),
  };
  const header = formatCall({ tool: "outline", args: call });

  let steps: Step[];
  let rootKey: string | undefined;
  let scopeWhere: Where = {};
  let base: { stepId?: string; branch?: string } = {};
  let owner: { parentId?: string; branch?: string } = {};
  let subtreeRoot: string | undefined;
  if (stepId === undefined) {
    if (branch !== undefined) throw new FlowlineTreeError("outline: `branch` needs `stepId`");
    steps = doc.steps;
    rootKey = listKey(null, undefined);
  } else {
    const found = findStep(doc, stepId);
    if (!found) throw new FlowlineTreeError(`outline: unknown step "${stepId}"`);
    const step = found.step;
    if (branch === undefined) {
      if (after !== undefined) {
        throw new FlowlineTreeError("outline: `after` pages a list; pass `branch` with `stepId`");
      }
      steps = [step];
      rootKey = undefined;
      base = { stepId };
      scopeWhere = { within: { stepId } };
      subtreeRoot = stepId;
    } else {
      const node = manifest.nodes.find((n) => n.type === step.type);
      const declared = node ? branchesFor(node, step).map((b) => b.id) : [];
      if (!declared.includes(branch) && !Object.hasOwn(step.branches ?? {}, branch)) {
        throw new FlowlineTreeError(`outline: step "${stepId}" has no branch "${branch}"`);
      }
      steps = step.branches?.[branch] ?? [];
      rootKey = listKey(stepId, branch);
      base = { stepId, branch };
      owner = { parentId: stepId, branch };
      scopeWhere = { within: { stepId, branch } };
    }
  }

  let offset = 0;
  if (after !== undefined) {
    const at = steps.findIndex((s) => s.id === after);
    if (at < 0) throw new FlowlineTreeError(`outline: step "${after}" isn't in that list`);
    offset = at + 1;
  }

  const model = buildModel(doc, manifest, opts, {
    header: [header],
    steps,
    offset,
    rootKey,
    ...owner,
    base,
    scopeWhere,
    ...(subtreeRoot !== undefined ? { subtreeRoot } : {}),
    whole: false,
  });
  return fit(model, args.budget);
}
