/**
 * The detail reads an agent uses after `overview`/`outline`: `focus`, `getSteps`, `findSteps`,
 * `availableRefs`, `listNodeTypes`, `describeNodeTypes` and `getIssues`, plus {@link reads}, every
 * read by tool name.
 *
 * @module
 */
import { sectionOf } from "../annotations";
import { branchesFor, derefSchema, describeType, schemaAtPath } from "../json-schema";
import { formatRefPath, isRef, isTpl, parseRefPath, type RefPath } from "../refs";
import { availableScope, indexManifest, resolveRefSchema, type ScopeEntry } from "../scope";
import { FlowlineTreeError, type FoundStep, findStep, walkSteps } from "../tree";
import type {
  JSONSchema,
  Manifest,
  NodeManifest,
  RuleOperatorMeta,
  Section,
  ValueExpr,
  WorkflowDoc,
} from "../types";
import { UI_META_KEY } from "../ui";
import { type Issue, validateWorkflow } from "../validate";
import { compactSchema } from "./compact-schema";
import { cutString, shownColor, shownLabel, stepLine } from "./format";
import { outline, overview } from "./outline";
import type {
  FollowUp,
  Include,
  ReadArgs,
  ReadFn,
  ReadOptions,
  ReadResults,
  ReadToolName,
  RefInfo,
  SectionInfo,
  StepDetail,
} from "./read-types";
import { matchSteps } from "./selectors";

/** Strings longer than this are cut in step reads, unless `full: true`. */
const CUT_MAX = 500;
/** Default and largest page size of `getSteps({ where })`. */
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
/** Notes are shown to this length in `findSteps` lines, as in the outline. */
const LINE_NOTE_MAX = 120;

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Cuts strings over {@link CUT_MAX} (unless `full`), recording each cut's path. */
class Cutter {
  readonly paths: string[] = [];
  constructor(private readonly full: boolean) {}

  str(s: string, path: string): string {
    if (this.full) return s;
    const c = cutString(s, CUT_MAX);
    if (c.cut) this.paths.push(path);
    return c.text;
  }

  value(v: ValueExpr, path: string): ValueExpr {
    if (typeof v === "string") return this.str(v, path);
    if (Array.isArray(v)) return v.map((x, i) => this.value(x, `${path}[${i}]`));
    if (typeof v !== "object" || v === null) return v;
    if (isRef(v)) return { ...v };
    if (isTpl(v)) return { ...v, $tpl: this.str(v.$tpl, path) };
    const out: { [k: string]: ValueExpr } = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] = this.value(x, IDENT.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`);
    }
    return out;
  }
}

/** What every step read of one call shares: the node index and the doc's issues. */
interface ReadContext {
  doc: WorkflowDoc;
  manifest: Manifest;
  nodes: Map<string, NodeManifest>;
  issues: Issue[];
  opts: ReadOptions;
}

function readContext(doc: WorkflowDoc, manifest: Manifest, opts: ReadOptions): ReadContext {
  return {
    doc,
    manifest,
    nodes: indexManifest(manifest).nodes,
    issues: validateWorkflow(doc, manifest, opts.ctx),
    opts,
  };
}

function sectionInfo(section: Section, cutter: Cutter, path: string): SectionInfo {
  return {
    id: String(section.id),
    title: cutter.str(String(section.title ?? ""), `${path}.title`),
    color: shownColor(section.color),
    ...(typeof section.note === "string" && section.note !== ""
      ? { note: cutter.str(section.note, `${path}.note`) }
      : {}),
  };
}

function refInfo(entry: ScopeEntry): RefInfo {
  const children = childSchemas(entry.schema).length;
  return {
    ref: entry.refBase,
    type: describeType(entry.schema),
    label: entry.label,
    ...(entry.disabled ? { disabled: true } : {}),
    ...(children > 0 ? { children } : {}),
  };
}

/** Property names of an object schema, looking through refs, nullable unions and `allOf`. */
function propertyNames(root: JSONSchema, schema: JSONSchema, depth = 0): string[] {
  if (depth > 8) return [];
  const s = derefSchema(root, schema);
  const names: string[] = [];
  const add = (xs: string[]) => {
    for (const x of xs) if (!names.includes(x)) names.push(x);
  };
  const props = s.properties;
  if (typeof props === "object" && props !== null) add(Object.keys(props));
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const members = s[key];
    if (!Array.isArray(members)) continue;
    for (const m of members) {
      if (typeof m === "object" && m !== null) add(propertyNames(root, m as JSONSchema, depth + 1));
    }
  }
  return names;
}

/** The child properties of a value of `schema`: `[segments, schema]` for each. */
function childSchemas(schema: JSONSchema): [(string | number)[], JSONSchema][] {
  const out: [(string | number)[], JSONSchema][] = [];
  for (const name of propertyNames(schema, schema)) {
    const child = schemaAtPath(schema, [name]);
    if (child !== undefined) out.push([[name], child]);
  }
  return out;
}

/** The refs in scope at `stepId`, top level. */
function topRefs(ctx: ReadContext, stepId: string): RefInfo[] {
  return availableScope(ctx.doc, stepId, ctx.manifest, ctx.opts.ctx).map(refInfo);
}

/** Builds a step's detail. `fullCall` is the call that returns it uncut. */
function stepDetail(
  ctx: ReadContext,
  found: FoundStep,
  include: ReadonlySet<Include>,
  full: boolean,
  fullCall: FollowUp,
): StepDetail {
  const { step, location } = found;
  const cutter = new Cutter(full);
  const node = ctx.nodes.get(step.type);
  const detail: StepDetail = {
    id: step.id,
    type: step.type,
    nodeLabel: node?.name ?? step.type,
    location: {
      parentId: location.parentId,
      ...(location.branch !== undefined ? { branch: location.branch } : {}),
      index: location.index,
    },
    issues: ctx.issues.filter((i) => i.stepId === step.id),
  };
  if (typeof step.name === "string" && step.name !== "") {
    detail.name = cutter.str(step.name, "name");
  }
  if (step.disabled === true) detail.disabled = true;
  if (typeof step.note === "string" && step.note !== "") {
    detail.note = cutter.str(step.note, "note");
  }
  if (step.color !== undefined) detail.color = shownColor(step.color);

  const section = sectionOf(ctx.doc, step.id);
  if (section) detail.section = sectionInfo(section, cutter, "section");
  const sections = Array.isArray(ctx.doc.sections) ? ctx.doc.sections : [];
  const heads = sections.filter((s) => s !== section && s.first === step.id);
  if (heads.length > 0) {
    detail.heads = heads.map((s, i) => sectionInfo(s, cutter, `heads[${i}]`));
  }

  if (include.has("config")) {
    const config = typeof step.config === "object" && step.config !== null ? step.config : {};
    detail.config = cutter.value(config, "config") as Record<string, ValueExpr>;
  }
  if (include.has("schema") && node) detail.schema = compactSchema(node.input);
  if (include.has("refs")) detail.refs = topRefs(ctx, step.id);

  const declared = node ? branchesFor(node, step) : [];
  const all = [...declared];
  for (const id of Object.keys(step.branches ?? {})) {
    if (!all.some((b) => b.id === id)) all.push({ id, label: id });
  }
  if (all.length > 0) {
    detail.branches = all.map((b, i) => ({
      id: b.id,
      label: cutter.str(b.label, `branches[${i}].label`),
      steps: step.branches?.[b.id]?.length ?? 0,
    }));
  }

  if (cutter.paths.length > 0) {
    detail.cut = cutter.paths;
    detail.full = fullCall;
  }
  return detail;
}

/**
 * Everything needed to edit one step: its name, note, colour and containing section, its config,
 * the node's compact input schema, the refs in scope, its issues, and its branches with step
 * counts. Strings over 500 chars are cut with `…(+N chars)` and listed in `cut`, unless `full`
 * is set (`full` in the result is that call). Throws a `FlowlineTreeError` for an unknown step.
 *
 * @example
 * focus(doc, manifest, { stepId: "notifyOwner" }).refs // [{ ref: "trigger", … }, …]
 */
export function focus(
  doc: WorkflowDoc,
  manifest: Manifest,
  args: ReadArgs["focus"],
  opts: ReadOptions = {},
): StepDetail {
  const found = findStep(doc, args.stepId);
  if (!found) throw new FlowlineTreeError(`focus: unknown step "${args.stepId}"`);
  const ctx = readContext(doc, manifest, opts);
  return stepDetail(
    ctx,
    found,
    new Set<Include>(["config", "schema", "refs"]),
    args.full === true,
    {
      tool: "focus",
      args: { stepId: args.stepId, full: true },
    },
  );
}

/** Pre-order position of every step. */
function preorder(doc: WorkflowDoc): Map<string, number> {
  const at = new Map<string, number>();
  walkSteps(doc, (s) => {
    if (!at.has(s.id)) at.set(s.id, at.size);
  });
  return at;
}

function pageSize(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return PAGE_DEFAULT;
  return Math.min(PAGE_MAX, Math.max(1, Math.floor(limit)));
}

/**
 * Several steps as {@link StepDetail}s:
 * - `{ ids }`: those steps, in the given order; IDs that aren't in the doc go to `missing`.
 * - `{ where, after?, limit? }`: the steps the selector matches, in pre-order, starting after the
 *   step `after`. `limit` defaults to 50 and is capped at 200; `next` is the call for the next
 *   page when more steps match. Throws a `FlowlineTreeError` when `after` isn't a step.
 *
 * `include` (default `["config"]`) adds config, the compact schema and the refs in scope.
 * Strings over 500 chars are cut with `…(+N chars)` unless `full: true`; each step lists its
 * cut paths in `cut`, and `full` in the result is the call that returns every cut step uncut.
 *
 * @example
 * getSteps(doc, manifest, { where: { type: "crm.sendEmail" }, include: [] })
 */
export function getSteps(
  doc: WorkflowDoc,
  manifest: Manifest,
  args: ReadArgs["getSteps"],
  opts: ReadOptions = {},
): ReadResults["getSteps"] {
  const includeList: Include[] = [...(args.include ?? ["config"])];
  const include = new Set(includeList);
  const full = args.full === true;
  const found: FoundStep[] = [];
  const missing: string[] = [];
  let next: FollowUp | undefined;

  if ("ids" in args && Array.isArray(args.ids)) {
    for (const id of args.ids) {
      const f = findStep(doc, id);
      if (f) found.push(f);
      else missing.push(id);
    }
  } else {
    const a = args as Extract<ReadArgs["getSteps"], { where: unknown }>;
    let ids = matchSteps(doc, manifest, a.where ?? {});
    if (a.after !== undefined) {
      const order = preorder(doc);
      const from = order.get(a.after);
      if (from === undefined) throw new FlowlineTreeError(`getSteps: unknown step "${a.after}"`);
      ids = ids.filter((id) => (order.get(id) ?? -1) > from);
    }
    const size = pageSize(a.limit);
    const page = ids.slice(0, size);
    for (const id of page) {
      const f = findStep(doc, id);
      if (f) found.push(f);
    }
    const last = page[page.length - 1];
    if (ids.length > size && last !== undefined) {
      next = { tool: "getSteps", args: { ...a, after: last } };
    }
  }

  const ctx = readContext(doc, manifest, opts);
  const steps = found.map((f) =>
    stepDetail(ctx, f, include, full, {
      tool: "getSteps",
      args: { ids: [f.step.id], include: includeList, full: true },
    }),
  );
  const cutIds = [...new Set(steps.filter((s) => s.cut).map((s) => s.id))];
  return {
    steps,
    missing,
    ...(next ? { next } : {}),
    ...(cutIds.length > 0
      ? { full: { tool: "getSteps", args: { ids: cutIds, include: includeList, full: true } } }
      : {}),
  };
}

/** Per-step issue counts, as the outline shows them (section issues left out). */
function issueCounts(issues: Issue[]): Map<string, number> {
  const per = new Map<string, number>();
  for (const i of issues) {
    if (i.stepId !== undefined && i.sectionId === undefined) {
      per.set(i.stepId, (per.get(i.stepId) ?? 0) + 1);
    }
  }
  return per;
}

/**
 * The steps a selector matches, in pre-order: their count, and each one's ID and outline line
 * (as `stepLine` draws it), so an agent can preview a bulk edit.
 *
 * @example
 * findSteps(doc, manifest, { where: { section: "check" } }).count // 4
 */
export function findSteps(
  doc: WorkflowDoc,
  manifest: Manifest,
  args: ReadArgs["findSteps"],
  opts: ReadOptions = {},
): ReadResults["findSteps"] {
  const ids = matchSteps(doc, manifest, args.where ?? {});
  const nodes = indexManifest(manifest).nodes;
  const counts = issueCounts(validateWorkflow(doc, manifest, opts.ctx));
  const matches = ids.flatMap((id) => {
    const f = findStep(doc, id);
    if (!f) return [];
    const line = stepLine(f.step, nodes.get(f.step.type), counts.get(id) ?? 0, LINE_NOTE_MAX);
    return [{ id, line }];
  });
  return { count: matches.length, matches };
}

/**
 * The `{{ }}` refs in scope at a step (the trigger, earlier steps, enclosing blocks, `loop` in a
 * loop body), each with its `describeType` type:
 * - no `path`: the top-level refs (`trigger`, `steps.<id>`, `loop`);
 * - `path`, e.g. `"steps.getDeal.deal"`: the child properties of the value there.
 *
 * Throws a `FlowlineTreeError` for an unknown step, or a `path` that isn't a ref path, isn't in
 * scope at the step, or doesn't exist.
 *
 * @example
 * availableRefs(doc, manifest, { stepId: "notifyOwner", path: "steps.getDeal.deal" })
 * // { refs: [{ ref: "steps.getDeal.deal.id", type: "string", label: "id" }, …] }
 */
export function availableRefs(
  doc: WorkflowDoc,
  manifest: Manifest,
  args: ReadArgs["availableRefs"],
  opts: ReadOptions = {},
): ReadResults["availableRefs"] {
  const { stepId, path } = args;
  if (!findStep(doc, stepId))
    throw new FlowlineTreeError(`availableRefs: unknown step "${stepId}"`);
  const visible = availableScope(doc, stepId, manifest, opts.ctx);
  if (path === undefined || path === "") return { refs: visible.map(refInfo) };

  let parsed: RefPath;
  if (path === "loop") parsed = { root: "loop", segments: [] };
  else {
    try {
      parsed = parseRefPath(path);
    } catch {
      throw new FlowlineTreeError(`availableRefs: "${path}" isn't a ref path`);
    }
  }
  let schema: JSONSchema;
  if (path === "loop") {
    const entry = visible.find((e) => e.refBase === "loop");
    if (!entry) throw new FlowlineTreeError(`availableRefs: "loop" isn't in scope at "${stepId}"`);
    schema = entry.schema;
  } else {
    const res = resolveRefSchema(parsed, visible);
    if (!res.ok) {
      throw new FlowlineTreeError(
        res.reason === "notVisible"
          ? `availableRefs: "${path}" isn't in scope at "${stepId}"`
          : `availableRefs: "${path}" doesn't exist`,
      );
    }
    schema = res.schema;
  }
  const refs = childSchemas(schema).map(([segs, child]): RefInfo => {
    const children = childSchemas(child).length;
    return {
      ref: formatRefPath({ ...parsed, segments: [...parsed.segments, ...segs] }),
      type: describeType(child),
      label: String(segs[segs.length - 1]),
      ...(children > 0 ? { children } : {}),
    };
  });
  return { refs };
}

/** How well `n` matches the query words: 0 when a word matches nothing. */
function matchScore(n: NodeManifest, words: string[]): number {
  let total = 0;
  const label = n.name.toLowerCase();
  const type = n.type.toLowerCase();
  const keywords = (n.keywords ?? []).map((k) => k.toLowerCase());
  const description = (n.description ?? "").toLowerCase();
  for (const w of words) {
    let s = 0;
    if (label === w || type === w) s = 100;
    else if (label.startsWith(w)) s = 80;
    else if (label.split(/\s+/).some((x) => x.startsWith(w))) s = 70;
    else if (label.includes(w)) s = 60;
    if (keywords.includes(w)) s = Math.max(s, 55);
    if (type.includes(w)) s = Math.max(s, 50);
    if (keywords.some((k) => k.includes(w))) s = Math.max(s, 40);
    if (description.includes(w)) s = Math.max(s, 10);
    if (s === 0) return 0;
    total += s;
  }
  return total;
}

/**
 * Node types: their type, label, a one-line description and category. No schemas (use
 * `describeNodeTypes`).
 * - `category` keeps the types in that category (case-insensitive).
 * - `query` keeps the types that match every word of it, best first: a match on the label ranks
 *   above one on a keyword or the type, which ranks above one on the description.
 *
 * Without a query, types are in manifest order. `doc` is not used.
 *
 * @example
 * listNodeTypes(null, manifest, { query: "mail" }).types[0].type // "crm.sendEmail"
 */
export function listNodeTypes(
  _doc: WorkflowDoc | null,
  manifest: Manifest,
  args: ReadArgs["listNodeTypes"],
): ReadResults["listNodeTypes"] {
  const category = args.category?.toLowerCase();
  let nodes = manifest.nodes.filter(
    (n) => category === undefined || n.category?.toLowerCase() === category,
  );
  const words = (args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    nodes = nodes
      .map((n, i) => ({ n, i, s: matchScore(n, words) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((x) => x.n);
  }
  return {
    types: nodes.map((n) => ({
      type: n.type,
      label: n.name,
      ...(n.description !== undefined && n.description !== ""
        ? { description: shownLabel(n.description) }
        : {}),
      ...(n.category !== undefined ? { category: n.category } : {}),
    })),
  };
}

/** Host rule operators declared anywhere in a schema (`x-flowline.operators`), deduplicated. */
function operatorsIn(schema: JSONSchema): RuleOperatorMeta[] {
  const out: RuleOperatorMeta[] = [];
  const seen = new Set<unknown>();
  const visit = (v: unknown) => {
    if (typeof v !== "object" || v === null || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    const meta = (v as Record<string, unknown>)[UI_META_KEY];
    const ops =
      typeof meta === "object" && meta !== null
        ? (meta as { operators?: unknown }).operators
        : undefined;
    if (Array.isArray(ops)) {
      for (const op of ops as RuleOperatorMeta[]) {
        if (!out.some((o) => o.id === op.id)) out.push(op);
      }
    }
    for (const x of Object.values(v)) visit(x);
  };
  visit(schema);
  return out;
}

type NodeDescription = ReadResults["describeNodeTypes"]["types"][number];

function branchInfo(n: NodeManifest): NodeDescription["branches"] {
  const spec = n.branches;
  switch (spec.kind) {
    case "static":
      return { kind: "static", ids: spec.branches.map((b) => b.id) };
    case "fromConfig":
      return {
        kind: "fromConfig",
        fromConfig: `${spec.configPath}[].${spec.idKey}`,
        ...(spec.append.length > 0 ? { ids: spec.append.map((b) => b.id) } : {}),
      };
    case "loop":
      return { kind: "loop", ids: [spec.branch] };
    default:
      return { kind: spec.kind };
  }
}

/**
 * Full descriptions of the given node types: the compact input schema (`compactSchema`), the
 * branches, the output (a compact schema, or `{ declaredBy: "config.<path>" }` when config
 * declares it) and any host rule operators. Types not in the manifest are listed in `unknown`.
 * `doc` is not used.
 *
 * @example
 * describeNodeTypes(null, manifest, { types: ["core.switch"] }).types[0].branches
 * // { kind: "fromConfig", fromConfig: "cases[].id", ids: ["default"] }
 */
export function describeNodeTypes(
  _doc: WorkflowDoc | null,
  manifest: Manifest,
  args: ReadArgs["describeNodeTypes"],
): ReadResults["describeNodeTypes"] {
  const nodes = indexManifest(manifest).nodes;
  const types: NodeDescription[] = [];
  const unknown: string[] = [];
  for (const type of args.types ?? []) {
    const n = nodes.get(type);
    if (!n) {
      unknown.push(type);
      continue;
    }
    const operators = operatorsIn(n.input);
    types.push({
      type: n.type,
      label: n.name,
      input: compactSchema(n.input),
      branches: branchInfo(n),
      output:
        n.output.kind === "schema"
          ? compactSchema(n.output.schema)
          : { declaredBy: `config.${n.output.configPath}` },
      ...(operators.length > 0 ? { operators } : {}),
    });
  }
  return { types, unknown };
}

/**
 * The doc's validation issues, or one step's (`stepId`: the issues whose `stepId` is that step),
 * with counts by severity.
 *
 * @example
 * getIssues(doc, manifest, { stepId: "recheck" }) // { issues: [...], errors: 1, warnings: 0 }
 */
export function getIssues(
  doc: WorkflowDoc,
  manifest: Manifest,
  args: ReadArgs["getIssues"],
  opts: ReadOptions = {},
): ReadResults["getIssues"] {
  const all = validateWorkflow(doc, manifest, opts.ctx);
  const issues = args.stepId === undefined ? all : all.filter((i) => i.stepId === args.stepId);
  const errors = issues.filter((i) => i.severity === "error").length;
  return { issues, errors, warnings: issues.length - errors };
}

/**
 * Every read, by tool name, each callable as `reads[name](doc, manifest, args, opts?)`, so a
 * {@link FollowUp} runs as `reads[f.tool](doc, manifest, f.args)`.
 */
export const reads: { [K in ReadToolName]: ReadFn<K> } = {
  overview,
  outline,
  focus,
  getSteps,
  findSteps,
  availableRefs,
  listNodeTypes,
  describeNodeTypes,
  getIssues,
};
