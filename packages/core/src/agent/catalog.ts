/**
 * The tool catalog an AI agent sees (the `apply` tool and one tool per read, with names,
 * descriptions and input schemas derived from the host manifest), and {@link runTool}, which runs
 * one tool call.
 *
 * @module
 */
import { z } from "zod";
import type { ValidationContext } from "../scope";
import { FlowlineTreeError } from "../tree";
import type { JSONSchema, Manifest, NodeManifest, WorkflowDoc } from "../types";
import { apply } from "./apply";
import {
  type CommandParts,
  commandParts,
  commandSchema,
  formatPath,
  whereFields,
  whereSchema,
} from "./command-schema";
import type { Command } from "./commands";
import type { ReadArgs, ReadFn, ReadToolName } from "./read-types";
import { reads } from "./reads";

/** One tool as a tool-calling model sees it. */
export interface ToolDefinition {
  /** The tool name: `"apply"` or a read's name. */
  name: string;
  /** What the tool does, written for a model, with a short JSON example. */
  description: string;
  /** The tool's input as plain JSON Schema (draft 2020-12), shared pieces under `$defs`. */
  inputSchema: JSONSchema;
}

/** What {@link runTool} runs against: the doc, its manifest and an optional validation context. */
export type ToolState = { doc: WorkflowDoc; manifest: Manifest; ctx?: ValidationContext };

/** Why {@link runTool} couldn't run a call. */
type ToolError = { code: "tool.unknown" | "command.invalid"; message: string; path?: string };

// Field schemas the catalog swaps manifest enums into, by identity.
const categoryField = z.string();
const budget = z.number().int().min(1);
const stepId = z.string().min(1);
const include = z.array(z.enum(["config", "schema", "refs"]));
const limit = z.number().int().min(1);

/**
 * Strict Zod schemas of each read's arguments (`Where` reuses `whereSchema`). The catalog's read
 * input schemas are generated from these, and {@link runTool} parses with them.
 *
 * @example
 * readArgSchemas.focus.safeParse({ stepId: "getDeal", full: true }).success // true
 */
export const readArgSchemas: { [K in ReadToolName]: z.ZodType<ReadArgs[K]> } = {
  overview: z.strictObject({ budget: budget.optional() }),
  outline: z.strictObject({
    stepId: stepId.optional(),
    branch: whereFields.branch.optional(),
    after: z.string().optional(),
    budget: budget.optional(),
  }),
  focus: z.strictObject({ stepId, full: z.boolean().optional(), budget: budget.optional() }),
  getSteps: z.union([
    z.strictObject({
      ids: z.array(z.string()),
      include: include.optional(),
      full: z.boolean().optional(),
      budget: budget.optional(),
    }),
    z.strictObject({
      where: whereSchema,
      after: z.string().optional(),
      limit: limit.optional(),
      include: include.optional(),
      full: z.boolean().optional(),
      budget: budget.optional(),
    }),
  ]),
  findSteps: z.strictObject({
    where: whereSchema,
    after: z.string().optional(),
    limit: limit.optional(),
  }),
  availableRefs: z.strictObject({ stepId, path: z.string().optional() }),
  listNodeTypes: z.strictObject({
    query: z.string().optional(),
    category: categoryField.optional(),
  }),
  describeNodeTypes: z.strictObject({ types: z.array(whereFields.type).min(1) }),
  getIssues: z.strictObject({ stepId: stepId.optional() }),
};

const READ_NAMES = Object.keys(readArgSchemas) as ReadToolName[];

/** Field descriptions of the read arguments, by schema identity. */
const READ_FIELD_META: [z.ZodType, string][] = [
  [budget, "Size limit in characters of the result"],
  [include, 'Extras per step: "config" (the default), "schema", "refs"'],
  [limit, "Page size"],
];

/** One line per op, for the model. */
const OP_DESCRIPTIONS: Record<string, string> = {
  addStep: "Add one step at `at`; config merges over the node's defaults. $n is the new step.",
  moveStep: "Move a step (with its subtree) to `to`.",
  removeStep: "Remove a step and its subtree.",
  setConfig: "Set one config key (value null removes it), or merge a config patch.",
  duplicateStep: "Copy a step and its subtree right after it. $n is the copy.",
  renameStep: 'Set the display name; "" clears it.',
  renameStepId: "Change a step's ID and rewrite every reference to it. $n is the new ID.",
  setType: "Change a step's node type: config resets to the new node's defaults, children stay.",
  setDisabled: "Disable or enable a step.",
  setNote: "Set the step's note; null removes it.",
  setColor: "Set the step's accent colour; null removes it.",
  setTrigger:
    "Set the trigger. Same type: merges config. Another type: resets config to its defaults, then merges.",
  setTriggerConfig: "Set one trigger config key (null removes it), or merge a patch.",
  setOutput: "Set one key of the workflow's output mapping (null removes it), or merge a patch.",
  renameWorkflow: "Rename the workflow.",
  addSection:
    "Group the run first…last (one list, in order) in a titled, coloured section. $n is the section.",
  updateSection: "Change a section's title, colour, note (null removes it) or first/last step.",
  removeSection: "Remove a section; its steps stay.",
  insertSteps:
    "Insert new steps (fragments, with nested branches) at `at`, optionally in a new section. $n is the first inserted step.",
  replaceSteps: "Replace the run first…last with new steps. $n is the first new step.",
  duplicateSteps: "Copy the run first…last, after last or at `at`. $n is the first copy.",
  updateSteps: "Edit many steps: a list of updates, or one set/config for every `where` match.",
  replaceInConfig:
    "Replace text in string config values and templates of every step, or of the `where` matches; expect counts the steps changed.",
  moveSteps: "Move the run first…last as a block to `to`.",
  removeSteps: "Remove steps: by ids, the run first…last, or the `where` matches.",
  wrapSteps: "Put the run first…last in branch in.branch of a new in.type step. $n is the wrapper.",
  unwrapStep: "Replace a branching step with the steps of its branch `keep`; other branches go.",
};

const NODE_TYPE_DESCRIPTION = "A node type of this app (describeNodeTypes gives its config)";

/** The `Branch` def: an enum of every static branch ID, or free text with a pointer. */
function branchDef(m: Manifest): JSONSchema {
  const ids: string[] = [];
  let free = false;
  for (const n of m.nodes) {
    const spec = n.branches;
    if (spec.kind === "fromConfig") free = true;
    else if (spec.kind === "static") ids.push(...spec.branches.map((b) => b.id));
    else if (spec.kind === "loop") ids.push(spec.branch);
  }
  const unique = [...new Set(ids)];
  if (free || unique.length === 0) {
    return {
      type: "string",
      minLength: 1,
      description:
        "A branch ID. The valid IDs depend on the node: see branches in describeNodeTypes",
    };
  }
  return { type: "string", enum: unique, description: "A branch ID" };
}

function categories(m: Manifest): string[] {
  return [
    ...new Set(
      m.nodes.flatMap((n) => (n.category !== undefined && n.category !== "" ? [n.category] : [])),
    ),
  ];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function replaceWith(target: Record<string, unknown>, value: Record<string, unknown>): void {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, value);
}

/** The metadata registry that names the shared pieces and describes ops and read fields. */
function registryFor(parts: CommandParts) {
  const reg = z.registry<{ id?: string; description?: string }>();
  reg.add(parts.nodeType, { id: "NodeType", description: NODE_TYPE_DESCRIPTION });
  reg.add(parts.stepRef, {
    id: "StepRef",
    description: 'A step ID, or a placeholder: "$1" (the step commands[0] made), "$deal" (a ref)',
  });
  reg.add(parts.at, {
    id: "At",
    description:
      "Where steps go: after or before a step, into a branch (index: position, default the end) or at the start of the top-level list. For moves, the anchor is resolved after the moved steps are taken out.",
  });
  reg.add(parts.fragment, {
    id: "Fragment",
    description:
      'A new step. ref names it "$<ref>" for later fragments and commands; id is generated from type unless given; config merges over the node\'s defaults; branches holds nested steps by branch ID.',
  });
  reg.add(parts.json, {
    id: "ValueExpr",
    description:
      'A config value: a JSON literal, a ref { "$ref": "steps.<id>.<path>" } (or "trigger.<path>"), or a template { "$tpl": "text {{ steps.<id>.<path> }}" }. In a patch, null removes the key.',
  });
  reg.add(parts.color, { id: "Color" });
  reg.add(parts.branch, { id: "Branch" });
  reg.add(whereSchema, {
    id: "Where",
    description:
      "A step selector; fields are ANDed and {} matches every step. within: descendants of a step (optionally of one branch); section: a section's steps; configHas: a config path that is set.",
  });
  for (const [op, members] of parts.members) {
    const description = OP_DESCRIPTIONS[op];
    if (description === undefined) continue;
    for (const s of members) reg.add(s, { description });
  }
  for (const [s, description] of READ_FIELD_META) reg.add(s, { description });
  return reg;
}

/** Zod's JSON Schema without the noise a model doesn't need (safe-integer bounds, string keys). */
function tidy(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(tidy);
  if (!isObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "$schema") continue;
    if (k === "maximum" && x === Number.MAX_SAFE_INTEGER) continue;
    if (k === "minimum" && x === Number.MIN_SAFE_INTEGER) continue;
    if (k === "propertyNames" && JSON.stringify(x) === '{"type":"string"}') continue;
    out[k] = tidy(x);
  }
  return out;
}

/** `schema` with every generated (`__schemaN`) def inlined where it is referenced. */
function inlineGenerated(schema: Record<string, unknown>): Record<string, unknown> {
  const all = isObject(schema.$defs) ? schema.$defs : {};
  const generated = new Map(Object.entries(all).filter(([k]) => k.startsWith("__schema")));
  const visit = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(visit);
    if (!isObject(v)) return v;
    const ref = v.$ref;
    if (typeof ref === "string" && ref.startsWith("#/$defs/__schema")) {
      const body = generated.get(ref.slice("#/$defs/".length));
      const { $ref: _, ...rest } = v;
      return { ...(visit(body) as Record<string, unknown>), ...rest };
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)]));
  };
  const out = visit(schema) as Record<string, unknown>;
  if (isObject(out.$defs)) {
    const kept = Object.fromEntries(
      Object.entries(out.$defs).filter(([k]) => !k.startsWith("__schema")),
    );
    if (Object.keys(kept).length > 0) out.$defs = kept;
    else delete out.$defs;
  }
  return out;
}

/** The catalog JSON Schema of `schema` for manifest `m`. */
function toCatalogSchema(schema: z.ZodType, m: Manifest, parts: CommandParts): JSONSchema {
  const branch = branchDef(m);
  const cats = categories(m);
  const nodeTypes = m.nodes.map((n) => n.type);
  const raw = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
    reused: "ref",
    unrepresentable: "any",
    metadata: registryFor(parts),
    override: (ctx) => {
      const j = ctx.jsonSchema as Record<string, unknown>;
      const zodSchema: unknown = ctx.zodSchema;
      if (zodSchema === parts.branch) replaceWith(j, branch);
      else if (zodSchema === parts.branchKey || zodSchema === whereFields.branch) {
        replaceWith(j, { $ref: "#/$defs/Branch" });
      } else if (zodSchema === whereFields.type) replaceWith(j, { $ref: "#/$defs/NodeType" });
      else if (zodSchema === categoryField && cats.length > 0) {
        replaceWith(j, { type: "string", enum: cats });
      }
    },
  });
  const out = inlineGenerated(tidy(raw) as Record<string, unknown>);
  // Read schemas reference the shared enums without containing the schema that defines them.
  const text = JSON.stringify(out);
  const $defs = (isObject(out.$defs) ? out.$defs : {}) as Record<string, unknown>;
  if (text.includes('"#/$defs/NodeType"') && !$defs.NodeType) {
    $defs.NodeType =
      nodeTypes.length > 0
        ? { type: "string", enum: nodeTypes, description: NODE_TYPE_DESCRIPTION }
        : { type: "string", minLength: 1, description: NODE_TYPE_DESCRIPTION };
  }
  if (text.includes('"#/$defs/Branch"') && !$defs.Branch) $defs.Branch = branch;
  if (Object.keys($defs).length > 0) out.$defs = $defs;
  return out as JSONSchema;
}

/** A config key of `n` that takes a string, if any. */
function stringKey(n: NodeManifest): string | undefined {
  const props = isObject(n.input.properties) ? n.input.properties : {};
  return Object.keys(props).find((k) => (props[k] as JSONSchema | undefined)?.type === "string");
}

/**
 * For the examples: a plain node type that takes a string (the host's own before the built-in
 * `core.*` ones), that string key, and a node type with fixed branches.
 */
function exampleTypes(m: Manifest) {
  const plain = m.nodes.filter(
    (n) => n.branches.kind === "none" && n.endsRun !== true && stringKey(n) !== undefined,
  );
  const leaf = plain.find((n) => !n.type.startsWith("core.")) ?? plain[0] ?? m.nodes[0];
  const key = leaf ? stringKey(leaf) : undefined;
  const branching = m.nodes.find(
    (n) => n.branches.kind === "static" && n.branches.branches.length > 0,
  );
  return {
    leaf: leaf?.type ?? "my.node",
    key: key ?? "text",
    branching:
      branching?.branches.kind === "static"
        ? { type: branching.type, branch: branching.branches.branches[0]?.id as string }
        : undefined,
  };
}

function applyDescription(m: Manifest): string {
  const { leaf, key, branching } = exampleTypes(m);
  const inserted: unknown[] = [
    { ref: "a", type: leaf, config: { [key]: { $ref: "trigger.deal.id" } } },
  ];
  if (branching) {
    inserted.push({
      type: branching.type,
      branches: { [branching.branch]: [{ type: leaf, config: { [key]: "done" } }] },
    });
  }
  const build = {
    commands: [
      { op: "insertSteps", at: { after: "getDeal" }, steps: inserted },
      { op: "setConfig", id: "$a", key, value: { $tpl: "Hi {{ trigger.contact.name }}" } },
      { op: "addSection", first: "$1", last: "$1", title: "Notify", color: "blue" },
    ],
  };
  const bulk = {
    commands: [{ op: "updateSteps", where: { type: leaf }, set: { disabled: true }, expect: 2 }],
  };
  return [
    "Edit the workflow: run a batch of commands atomically. If any command fails, nothing is applied and `error` names it (path like commands[2].config.to) with a hint: the expected schema, or the closest valid names. Put all related edits in one call.",
    'Placeholders: $n is the result of commands[n-1] (1-based): the step (or section) it created. A fragment step with "ref": "a" becomes $<ref>, here "$a". Use them as step IDs and inside refs and templates: { "$ref": "steps.$1.deal.id" }, "{{ steps.$a.id }}". Unknown placeholders are rejected. result.ids maps each placeholder to its real ID.',
    'Values: a JSON literal, a ref { "$ref": "trigger.deal.id" }, or a template { "$tpl": "Hi {{ trigger.contact.name }}" }. In config patches, null removes a key.',
    "Bulk: insertSteps adds many new steps with nested branches in one command; replaceSteps, duplicateSteps, updateSteps, replaceInConfig, moveSteps, removeSteps, wrapSteps and unwrapStep act on runs (first…last, one list in order) or selectors. Every `where` form needs expect, the number of steps you expect it to match: another count fails with expect.mismatch and lists the matches.",
    "New steps with an unknown type or branch, an invalid config value or a bad ref are rejected; a missing required field is only reported in issues.",
    'On success, the result includes the changed outline and issue delta, so there\'s no need to re-read after success. changed has one line per step touched (+ added, ~ updated, - removed, "~ old →" for a new ID), plus "~ workflow", "~ trigger" and "~ output" lines when those changed. issues.added and issues.cleared are the validation delta; issues.more has a getIssues call when more than 20 were added.',
    `Example: ${JSON.stringify(build)}`,
    `Example: ${JSON.stringify(bulk)}`,
  ].join("\n");
}

function readDescriptions(m: Manifest): Record<ReadToolName, string> {
  const { leaf } = exampleTypes(m);
  const ex = (v: unknown) => `Example: ${JSON.stringify(v)}`;
  const cutNote =
    'Strings over 500 chars are cut, ending in a fixed marker "…(+N chars)" that is not part of the value; the step\'s cut lists the cut paths, and full is the call that returns them uncut.';
  return {
    overview: [
      "Start here. Then describeNodeTypes for any node type you'll add.",
      "The whole workflow as a compact outline: the trigger, then one line per step (ID, type, name, short config), sections (▣) and notes, nested by branch, with issue counts. A big workflow is cut to fit budget (characters, default 4000): omitted lists what was left out, each with the exact call (tool and args) that fetches it.",
      ex({}),
    ].join("\n"),
    outline: [
      "Part of the workflow in overview's format: one step's subtree (stepId), one of its branches (stepId and branch) or the top-level list (neither). after pages a list: only the steps after that step. Use it, or the calls in omitted, to expand what overview collapsed.",
      ex({ stepId: "recheck", branch: "else" }),
    ].join("\n"),
    focus: [
      "Everything needed to edit one step: config, its compact input schema, the refs in scope, issues, branches, its section (section; heads lists other sections that start here) and note.",
      cutNote,
      "Over budget (characters, default 8000), refs and then the schema are left out, each listed in omitted with its call.",
      ex({ stepId: "getDeal" }),
    ].join("\n"),
    getSteps: [
      'Several steps in focus\'s detail, by ids, or by a where selector (paged with after and limit: default 50, at most 200). include picks the extras: "config" (the default), "schema", "refs". Unknown IDs are in missing.',
      "Only the leading steps that fit budget (characters, default 8000) are returned; next is the call for more and remaining counts the steps left: follow next until remaining is 0; if next.ids is a slice, re-request the rest of your list.",
      `${cutNote} Here full is one call for every cut step of the page.`,
      ex({ ids: ["getDeal", "recheck"], include: ["config"] }),
    ].join("\n"),
    findSteps: [
      "The IDs and outline lines of the steps a where selector matches (fields ANDed; {} matches all), and count, the number of matches. Pages of limit (default 100, at most 500) after the step after; omitted has the call for the next page. Check a selector here before a command with where and expect.",
      ex({ where: { type: leaf } }),
    ].join("\n"),
    availableRefs: [
      'The refs in scope at a step, with their types: trigger, earlier steps\' outputs (steps.<id>) and loop items. Top level unless path drills in, e.g. "steps.getDeal.deal"; children counts the properties to drill into. Use the paths in { "$ref": … } values and {{ }} templates.',
      ex({ stepId: "notify", path: "steps.getDeal" }),
    ].join("\n"),
    listNodeTypes: [
      "The node types you can add: type, label, one-line description and category, best match first for query. No schemas: use describeNodeTypes.",
      ex({ query: "email" }),
    ].join("\n"),
    describeNodeTypes: [
      "Full descriptions of node types, read before adding them: the compact input schema (config keys, required fields), branches (fixed IDs, or the config path that defines them, e.g. cases[].id), the output schema (what steps.<id>… refs can read) and any rule operators. Types not in the app are listed in unknown.",
      ex({ types: [leaf] }),
    ].join("\n"),
    getIssues: [
      "Validation issues (errors and warnings) of the workflow, or of one step (stepId), with counts. apply already returns the delta; call this for the full list.",
      ex({}),
    ].join("\n"),
  };
}

const catalogs = new WeakMap<Manifest, ToolDefinition[]>();

function buildCatalog(m: Manifest): ToolDefinition[] {
  const parts = commandParts(m);
  const envelope = z.object({ commands: z.array(commandSchema(m, { internal: false })) });
  const described = readDescriptions(m);
  return [
    {
      name: "apply",
      description: applyDescription(m),
      inputSchema: toCatalogSchema(envelope, m, parts),
    },
    ...READ_NAMES.map((name) => ({
      name,
      description: described[name],
      inputSchema: toCatalogSchema(readArgSchemas[name], m, parts),
    })),
  ];
}

/**
 * The tools an AI agent gets for a manifest: `apply` (a batch of commands) and one tool per
 * read, each with a description written for a model and a plain JSON Schema input generated
 * from the manifest: node and trigger `type` fields are enums, `branch` fields are an enum of
 * the static branch IDs (free text when a node has config-driven branches), and shared pieces
 * sit once under `$defs`. `include` picks `"commands"` (`apply`), `"reads"` or both (default).
 * Built once per manifest object; treat the result as read-only.
 *
 * @example
 * const tools = commandCatalog(registry.manifest());
 * tools.map((t) => t.name) // ["apply", "overview", "outline", …, "getIssues"]
 */
export function commandCatalog(
  manifest: Manifest,
  opts: { include?: ("reads" | "commands")[] } = {},
): ToolDefinition[] {
  let all = catalogs.get(manifest);
  if (!all) {
    all = buildCatalog(manifest);
    catalogs.set(manifest, all);
  }
  const include = new Set(opts.include ?? ["commands", "reads"]);
  return all.filter((t) => (t.name === "apply" ? include.has("commands") : include.has("reads")));
}

function isReadName(name: string): name is ReadToolName {
  return Object.hasOwn(readArgSchemas, name);
}

/** The first issue of a failed parse as a `command.invalid` error. */
function argsError(tool: string, issues: readonly z.core.$ZodIssue[]): ToolError {
  const issue = issues[0] as z.core.$ZodIssue;
  const segs = issue.path as (string | number)[];
  if (issue.code === "unrecognized_keys") {
    const key = issue.keys[0] as string;
    const path = formatPath([...segs, key]);
    return { code: "command.invalid", message: `${tool}: unknown argument "${key}"`, path };
  }
  const path = formatPath(segs);
  const message =
    issue.code === "invalid_union"
      ? `${tool}: the arguments match none of the allowed forms`
      : `${tool}: ${path === "" ? "" : `${path}: `}${issue.message}`;
  return { code: "command.invalid", message, ...(path !== "" ? { path } : {}) };
}

/**
 * Runs one catalog tool call. For a read, `args` is parsed with {@link readArgSchemas} (a bad
 * argument, or one the read rejects such as an unknown step, fails with `command.invalid`) and
 * `result` is the read's result. For `"apply"`, only the `{ commands: [...] }` envelope is
 * checked: `result` is the ApplyResult (command errors, with their hints, come back inside it)
 * and `doc` is the new doc to keep, on success. `apply` runs untrusted: every command's shape
 * is checked and unknown placeholders are rejected. An unknown tool fails with `tool.unknown`.
 *
 * `result` of `apply` holds the whole new `doc`; a host sending results to a model can drop it.
 *
 * @example
 * const r = runTool({ doc, manifest }, "apply", { commands: [{ op: "removeStep", id: "notify" }] });
 * if (r.ok && r.doc) doc = r.doc;
 */
export function runTool(
  state: ToolState,
  name: string,
  args: unknown,
): { ok: true; result: unknown; doc?: WorkflowDoc } | { ok: false; error: ToolError } {
  const opts = state.ctx ? { ctx: state.ctx } : {};
  if (name === "apply") {
    if (!isObject(args) || !Array.isArray(args.commands)) {
      return {
        ok: false,
        error: {
          code: "command.invalid",
          message: "apply takes { commands: [...] }, an array of commands",
          path: "commands",
        },
      };
    }
    const result = apply(state.doc, args.commands as Command[], state.manifest, opts);
    return result.ok ? { ok: true, result, doc: result.doc } : { ok: true, result };
  }
  if (!isReadName(name)) {
    return {
      ok: false,
      error: {
        code: "tool.unknown",
        message: `Unknown tool "${name}". Tools: apply, ${READ_NAMES.join(", ")}`,
      },
    };
  }
  const parsed = readArgSchemas[name].safeParse(args);
  if (!parsed.success) return { ok: false, error: argsError(name, parsed.error.issues) };
  try {
    const read = reads[name] as ReadFn<ReadToolName>;
    return { ok: true, result: read(state.doc, state.manifest, parsed.data, opts) };
  } catch (err) {
    if (err instanceof FlowlineTreeError) {
      return { ok: false, error: { code: "command.invalid", message: err.message } };
    }
    throw err;
  }
}
