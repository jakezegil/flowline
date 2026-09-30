/**
 * Strict Zod schemas of the commands, their JSON Schemas for hints and the tool catalog, and the
 * shape check `apply` runs before any command.
 *
 * @module
 */
import { z } from "zod";
import { ANNOTATION_COLORS, NOTE_MAX_CHARS } from "../annotations";
import { STEP_ID_PATTERN } from "../ids";
import type { AnnotationColor, JSONSchema, Manifest } from "../types";
import { type ApplyError, type Command, type CommandErrorCode, closest } from "./commands";
import { compactSchema } from "./compact-schema";
import type { Where } from "./read-types";

/**
 * @internal The `Where` fields that name a node type and a branch, by schema identity, so the
 * catalog can turn them into the manifest's enums.
 */
export const whereFields = { type: z.string(), branch: z.string() } as const;

/**
 * Strict Zod schema of `Where`, shared by the selector commands and the read argument schemas.
 *
 * @example
 * whereSchema.safeParse({ type: "crm.sendEmail", within: { stepId: "check" } }).success // true
 */
export const whereSchema: z.ZodType<Where> = z.strictObject({
  type: whereFields.type.optional(),
  section: z.string().optional(),
  within: z
    .strictObject({ stepId: z.string().min(1), branch: whereFields.branch.optional() })
    .optional(),
  nameContains: z.string().optional(),
  configHas: z.string().optional(),
});

/**
 * Size limits on the untrusted (model-facing) path: `runTool`, the agent bridge and
 * `commandSchema(m, { internal: false })`. They stop one tool call from freezing the host or
 * defeating the read budgets. The store's trusted path has none.
 *
 * @example
 * if (commands.length > AGENT_LIMITS.commands) splitIntoBatches(commands);
 */
export const AGENT_LIMITS = {
  /** Commands in one `apply` call. */
  commands: 1000,
  /** Steps in one `insertSteps`/`replaceSteps` list, and IDs or updates in one bulk command. */
  list: 1000,
  /** Characters in a new step or section ID. */
  id: 64,
  /** Characters in a workflow name, step name or section title. */
  name: 200,
} as const;

/** The longest a `command.invalid` hint schema is, in characters of JSON. */
const HINT_MAX = 1500;

/** Where `v` stops being a JSON value (`undefined` when it is one). */
function nonJsonAt(v: unknown, path: (string | number)[]): (string | number)[] | undefined {
  if (v === null || typeof v === "string" || typeof v === "boolean") return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? undefined : path;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const bad = nonJsonAt(v[i], [...path, i]);
      if (bad) return bad;
    }
    return undefined;
  }
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return path;
    for (const [k, x] of Object.entries(v)) {
      const bad = nonJsonAt(x, [...path, k]);
      if (bad) return bad;
    }
    return undefined;
  }
  return path;
}

/** Any JSON value (`null` included), never checked against a field's schema. */
function jsonValue() {
  return z
    .unknown()
    .superRefine((v, ctx) => {
      const bad = nonJsonAt(v, []);
      if (bad) ctx.addIssue({ code: "custom", message: "Expected a JSON value", path: bad });
    })
    .meta({ description: "Any JSON value" });
}

/** The command schemas for one manifest, by op; an op with two forms has two members. */
interface Built {
  members: Map<string, z.ZodType[]>;
  union: z.ZodType<Command>;
  /** Each op's JSON Schema, built on first use. */
  json: Map<string, JSONSchema>;
  /** The (non-verbatim) fragment schema, the one recursive schema in the commands. */
  fragment: z.ZodType;
  /** Its compact JSON Schema, built on first use: what a `#recursive:` ref stands for. */
  fragmentJson?: JSONSchema;
  /** The shared pieces, by schema identity, for the catalog's `$defs` and enums. */
  parts: CommandParts;
}

/**
 * @internal The schemas the command schemas share, by identity: the catalog names them in
 * `$defs` and swaps manifest enums in for the branch fields.
 */
export interface CommandParts {
  /** Every command's schema by op (an op with two forms has two). */
  members: Map<string, z.ZodType[]>;
  /** A step argument (an ID or a placeholder). */
  stepRef: z.ZodType;
  at: z.ZodType;
  nodeType: z.ZodType;
  fragment: z.ZodType;
  json: z.ZodType;
  color: z.ZodType;
  /** A branch ID value (`at.in.branch`, `wrapSteps.in.branch`, `unwrapStep.keep`). */
  branch: z.ZodType;
  /** The key of a fragment's `branches`. */
  branchKey: z.ZodType;
}

/** A fragment schema: `type` as given, and `branches` holding fragments of the same schema. */
function fragmentSchema(
  type: z.ZodType,
  color: z.ZodType,
  json: z.ZodType,
  branchKey: z.ZodType<string> = z.string(),
  limited = false,
): z.ZodType {
  const newId = limited ? z.string().max(AGENT_LIMITS.id) : z.string();
  const name = limited ? z.string().max(AGENT_LIMITS.name) : z.string();
  const fragment: z.ZodType = z.strictObject({
    ref: z
      .string()
      .regex(STEP_ID_PATTERN, {
        message: "A ref starts with a letter or underscore, then letters, digits and underscores",
      })
      .optional(),
    id: newId.optional(),
    type,
    name: name.optional(),
    config: z.record(z.string(), json).optional(),
    note: z.string().max(NOTE_MAX_CHARS).optional(),
    color: color.optional(),
    disabled: z.boolean().optional(),
    get branches() {
      return z
        .record(branchKey, limited ? z.array(fragment).max(AGENT_LIMITS.list) : z.array(fragment))
        .optional();
    },
  });
  return fragment;
}

function build(manifest: Manifest | undefined, internal: boolean): Built {
  const stepRef = z.string().min(1);
  const newId = internal ? z.string() : z.string().max(AGENT_LIMITS.id);
  const name = internal ? z.string() : z.string().max(AGENT_LIMITS.name);
  const list = <T extends z.ZodType>(item: T) =>
    internal ? z.array(item) : z.array(item).max(AGENT_LIMITS.list);
  const branch = z.string().min(1);
  const branchKey = z.string();
  const at = z.union([
    z.strictObject({ after: stepRef }),
    z.strictObject({ before: stepRef }),
    z.strictObject({
      in: z.strictObject({ stepId: stepRef, branch }),
      index: z.number().int().min(0).optional(),
    }),
    z.strictObject({ start: z.literal(true) }),
  ]);
  const nodeTypes = manifest?.nodes.map((n) => n.type) ?? [];
  const nodeType =
    nodeTypes.length > 0 ? z.enum(nodeTypes as [string, ...string[]]) : z.string().min(1);
  const triggerTypes = manifest?.triggers.map((t) => t.type) ?? [];
  const triggerType =
    triggerTypes.length > 0 ? z.enum(triggerTypes as [string, ...string[]]) : z.string().min(1);
  const color = z.enum(ANNOTATION_COLORS as unknown as [AnnotationColor, ...AnnotationColor[]]);
  const json = jsonValue();
  /** An op that sets one key (`nullIsValue` internal only) or merges `config`. */
  const keyOrMerge = (op: string) => [
    z.strictObject({
      op: z.literal(op),
      key: z.string().min(1),
      value: json,
      ...(internal ? { nullIsValue: z.boolean().optional() } : {}),
    }),
    z.strictObject({ op: z.literal(op), config: z.record(z.string(), json) }),
  ];
  const members = new Map<string, z.ZodType[]>([
    [
      "addStep",
      [
        z.strictObject({
          op: z.literal("addStep"),
          at,
          type: nodeType,
          id: newId.optional(),
          name: name.optional(),
          config: z.record(z.string(), json).optional(),
          note: z.string().max(NOTE_MAX_CHARS).optional(),
          color: color.optional(),
          disabled: z.boolean().optional(),
        }),
      ],
    ],
    ["moveStep", [z.strictObject({ op: z.literal("moveStep"), id: stepRef, to: at })]],
    ["removeStep", [z.strictObject({ op: z.literal("removeStep"), id: stepRef })]],
    [
      "setConfig",
      [
        z.strictObject({
          op: z.literal("setConfig"),
          id: stepRef,
          key: z.string().min(1),
          value: json,
          ...(internal ? { nullIsValue: z.boolean().optional() } : {}),
        }),
        z.strictObject({
          op: z.literal("setConfig"),
          id: stepRef,
          config: z.record(z.string(), json),
        }),
      ],
    ],
    ["duplicateStep", [z.strictObject({ op: z.literal("duplicateStep"), id: stepRef })]],
    ["renameStep", [z.strictObject({ op: z.literal("renameStep"), id: stepRef, name })]],
    ["renameStepId", [z.strictObject({ op: z.literal("renameStepId"), id: stepRef, newId })]],
    ["setType", [z.strictObject({ op: z.literal("setType"), id: stepRef, type: nodeType })]],
    [
      "setDisabled",
      [z.strictObject({ op: z.literal("setDisabled"), id: stepRef, disabled: z.boolean() })],
    ],
    [
      "setNote",
      [
        z.strictObject({
          op: z.literal("setNote"),
          id: stepRef,
          note: z.string().max(NOTE_MAX_CHARS).nullable(),
        }),
      ],
    ],
    [
      "setColor",
      [z.strictObject({ op: z.literal("setColor"), id: stepRef, color: color.nullable() })],
    ],
    [
      "setTrigger",
      [
        z.strictObject({
          op: z.literal("setTrigger"),
          type: triggerType,
          config: z.record(z.string(), json).optional(),
        }),
      ],
    ],
    ["setTriggerConfig", keyOrMerge("setTriggerConfig")],
    ["setOutput", keyOrMerge("setOutput")],
    [
      "renameWorkflow",
      [
        z.strictObject({
          op: z.literal("renameWorkflow"),
          name: name.regex(/\S/, { message: "The name can't be blank" }),
        }),
      ],
    ],
    [
      "addSection",
      [
        z.strictObject({
          op: z.literal("addSection"),
          first: stepRef,
          last: stepRef,
          title: name,
          color,
          note: z.string().max(NOTE_MAX_CHARS).optional(),
          id: newId.optional(),
        }),
      ],
    ],
    [
      "updateSection",
      [
        z.strictObject({
          op: z.literal("updateSection"),
          id: stepRef,
          title: name.optional(),
          color: color.optional(),
          note: z.string().max(NOTE_MAX_CHARS).nullable().optional(),
          first: stepRef.optional(),
          last: stepRef.optional(),
        }),
      ],
    ],
    ["removeSection", [z.strictObject({ op: z.literal("removeSection"), id: stepRef })]],
  ]);
  const fragment = fragmentSchema(nodeType, color, json, branchKey, !internal);
  const steps = list(fragment).min(1);
  const section = z.strictObject({
    title: name,
    color,
    note: z.string().max(NOTE_MAX_CHARS).optional(),
    id: newId.optional(),
  });
  const insertSteps: z.ZodType[] = [
    z.strictObject({
      op: z.literal("insertSteps"),
      at,
      steps,
      section: section.optional(),
      ...(internal ? { verbatim: z.literal(false).optional() } : {}),
    }),
  ];
  if (internal) {
    // The store's paste: any node type (a pasted step may be of a type the manifest lacks).
    const pasted = fragmentSchema(z.string().min(1), color, json);
    insertSteps.push(
      z.strictObject({
        op: z.literal("insertSteps"),
        at,
        steps: z.array(pasted).min(1),
        section: section.optional(),
        verbatim: z.literal(true),
      }),
    );
  }
  members.set("insertSteps", insertSteps);
  members.set("replaceSteps", [
    z.strictObject({ op: z.literal("replaceSteps"), first: stepRef, last: stepRef, steps }),
  ]);
  const expectCount = z.number().int().min(0);
  const set = z.strictObject({
    name: name.optional(),
    disabled: z.boolean().optional(),
    note: z.string().max(NOTE_MAX_CHARS).nullable().optional(),
    color: color.nullable().optional(),
  });
  const patch = z.record(z.string(), json);
  members.set("duplicateSteps", [
    z.strictObject({
      op: z.literal("duplicateSteps"),
      first: stepRef,
      last: stepRef,
      at: at.optional(),
    }),
  ]);
  members.set("updateSteps", [
    z.strictObject({
      op: z.literal("updateSteps"),
      updates: list(
        z.strictObject({ id: stepRef, set: set.optional(), config: patch.optional() }),
      ).min(1),
    }),
    z.strictObject({
      op: z.literal("updateSteps"),
      where: whereSchema,
      set: set.optional(),
      config: patch.optional(),
      expect: expectCount,
    }),
  ]);
  members.set("replaceInConfig", [
    z.strictObject({
      op: z.literal("replaceInConfig"),
      find: z.string().min(1, { message: "find can't be empty" }),
      replace: z.string(),
      where: whereSchema.optional(),
      expect: expectCount,
    }),
  ]);
  members.set("moveSteps", [
    z.strictObject({ op: z.literal("moveSteps"), first: stepRef, last: stepRef, to: at }),
  ]);
  members.set("removeSteps", [
    z.strictObject({ op: z.literal("removeSteps"), ids: list(stepRef).min(1) }),
    z.strictObject({ op: z.literal("removeSteps"), first: stepRef, last: stepRef }),
    z.strictObject({ op: z.literal("removeSteps"), where: whereSchema, expect: expectCount }),
  ]);
  members.set("wrapSteps", [
    z.strictObject({
      op: z.literal("wrapSteps"),
      first: stepRef,
      last: stepRef,
      in: z.strictObject({
        type: nodeType,
        branch,
        config: patch.optional(),
      }),
    }),
  ]);
  members.set("unwrapStep", [
    z.strictObject({ op: z.literal("unwrapStep"), id: stepRef, keep: branch }),
  ]);
  const all = [...members.values()].flat();
  const union = z.union(all as [z.ZodType, z.ZodType, ...z.ZodType[]]) as z.ZodType<Command>;
  return {
    members,
    union,
    json: new Map(),
    fragment,
    parts: { members, stepRef, at, nodeType, fragment, json, color, branch, branchKey },
  };
}

/** The member of a multi-form op that `cmd` is checked against. */
function memberFor(op: string, members: z.ZodType[], cmd: Record<string, unknown>): z.ZodType {
  if (members.length === 1) return members[0] as z.ZodType;
  // insertSteps: `verbatim: true` picks the paste form.
  if (op === "insertSteps") return members[cmd.verbatim === true ? 1 : 0] as z.ZodType;
  // updateSteps: `updates` picks the list form, else the selector form.
  if (op === "updateSteps") return members["updates" in cmd ? 0 : 1] as z.ZodType;
  // removeSteps: `ids`, then `where`, else the run form.
  if (op === "removeSteps") {
    return members["ids" in cmd ? 0 : "where" in cmd ? 2 : 1] as z.ZodType;
  }
  // setConfig, setTriggerConfig, setOutput: `config` picks the merge form.
  return members[!("config" in cmd) ? 0 : members.length - 1] as z.ZodType;
}

const cache = new WeakMap<Manifest, { internal?: Built; external?: Built }>();
const noManifest: { internal?: Built; external?: Built } = {};

function built(manifest: Manifest | undefined, internal: boolean): Built {
  let slot = manifest ? cache.get(manifest) : noManifest;
  if (!slot) {
    slot = {};
    cache.set(manifest as Manifest, slot);
  }
  const key = internal ? "internal" : "external";
  let b = slot[key];
  if (!b) {
    b = build(manifest, internal);
    slot[key] = b;
  }
  return b;
}

/**
 * Zod schema of one command; with a manifest, `type` fields are enums of its node/trigger types.
 * `internal: true` (the default for apply) also accepts store-only fields (nullIsValue, verbatim).
 * Cached per (manifest object, internal) in a WeakMap.
 *
 * Every command object is strict: an unknown key fails, naming the key.
 *
 * @example
 * commandSchema(manifest).safeParse({ op: "removeStep", id: "getDeal" }).success // true
 */
export function commandSchema(
  manifest?: Manifest,
  opts: { internal?: boolean } = {},
): z.ZodType<Command> {
  return built(manifest, opts.internal ?? true).union;
}

/** @internal The shared pieces of the external command schemas for `manifest` (cached). */
export function commandParts(manifest?: Manifest): CommandParts {
  return built(manifest, false).parts;
}

/** @internal Every op name, in declaration order. */
export function commandOps(manifest?: Manifest): string[] {
  return [...built(manifest, false).members.keys()];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Zod's JSON Schema without the noise a model doesn't need (safe-integer bounds, string keys). */
function tidy(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(tidy);
  if (!isObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "maximum" && x === Number.MAX_SAFE_INTEGER) continue;
    if (k === "minimum" && x === Number.MIN_SAFE_INTEGER) continue;
    if (k === "propertyNames" && JSON.stringify(x) === '{"type":"string"}') continue;
    out[k] = tidy(x);
  }
  return out;
}

/** The JSON Schema of `op` (its forms as `anyOf`), or of `{ op: <enum> }` for an unknown op. */
function opSchema(b: Built, op: string): JSONSchema {
  const cached = b.json.get(op);
  if (cached) return cached;
  const members = b.members.get(op);
  let schema: JSONSchema;
  if (!members) {
    schema = {
      type: "object",
      properties: { op: { enum: [...b.members.keys()] } },
      required: ["op"],
    };
  } else {
    const forms = members.map(
      (s) => tidy(z.toJSONSchema(s, { unrepresentable: "any" })) as JSONSchema,
    );
    schema = forms.length === 1 ? (forms[0] as JSONSchema) : { anyOf: forms };
  }
  schema = compactSchema(schema);
  b.json.set(op, schema);
  return schema;
}

/** The subschema at one path segment, merging union members that have it. */
function stepInto(schema: JSONSchema, seg: string | number): JSONSchema | undefined {
  const union = (schema.anyOf ?? schema.oneOf) as unknown;
  if (Array.isArray(union)) {
    const found = union.flatMap((s) => {
      const r = isObject(s) ? stepInto(s as JSONSchema, seg) : undefined;
      return r ? [r] : [];
    });
    if (found.length === 0) return undefined;
    return found.length === 1 ? found[0] : { anyOf: found };
  }
  if (typeof seg === "number") {
    const prefix = schema.prefixItems;
    if (Array.isArray(prefix) && isObject(prefix[seg])) return prefix[seg] as JSONSchema;
    return isObject(schema.items) ? (schema.items as JSONSchema) : undefined;
  }
  const props = schema.properties;
  if (isObject(props) && isObject(props[seg])) return props[seg] as JSONSchema;
  return isObject(schema.additionalProperties)
    ? (schema.additionalProperties as JSONSchema)
    : undefined;
}

const TRUNCATED: JSONSchema = { $ref: "#truncated" };
const SUB_ONE = new Set(["items", "additionalProperties", "propertyNames", "not"]);
const SUB_LIST = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const SUB_MAP = new Set(["properties", "patternProperties"]);

/** `schema` with subschemas deeper than `depth` replaced by `{"$ref":"#truncated"}`. */
function limitDepth(schema: unknown, depth: number): unknown {
  if (!isObject(schema)) return schema;
  const sub = (x: unknown) => (depth <= 0 ? TRUNCATED : limitDepth(x, depth - 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (SUB_ONE.has(k) && isObject(v)) out[k] = sub(v);
    else if (SUB_LIST.has(k) && Array.isArray(v)) out[k] = v.map(sub);
    else if (SUB_MAP.has(k) && isObject(v))
      out[k] = Object.fromEntries(Object.entries(v).map(([n, x]) => [n, sub(x)]));
    else out[k] = v;
  }
  return out;
}

/** `schema` with every `enum` of more than `max` values cut to its first `max`. */
function cutEnums(schema: unknown, max: number): unknown {
  if (Array.isArray(schema)) return schema.map((x) => cutEnums(x, max));
  if (!isObject(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "enum" && Array.isArray(v) && v.length > max) {
      out.enum = v.slice(0, max);
      out.description = `One of ${v.length} values; ${v.length - max} more not shown`;
    } else {
      out[k] = cutEnums(v, max);
    }
  }
  return out;
}

const size = (v: unknown) => JSON.stringify(v).length;

/** `schema` made to fit {@link HINT_MAX}: long enums cut, then deep subtrees truncated. */
function fitHint(schema: JSONSchema): JSONSchema {
  if (size(schema) <= HINT_MAX) return schema;
  const cut = cutEnums(schema, 10) as JSONSchema;
  if (size(cut) <= HINT_MAX) return cut;
  for (let depth = 6; depth >= 0; depth--) {
    const limited = limitDepth(cut, depth) as JSONSchema;
    if (size(limited) <= HINT_MAX) return limited;
  }
  return TRUNCATED;
}

/**
 * Compact JSON Schema of the command schema at `path` (e.g. ["steps", 0, "branches"]), ≤ 1500
 * chars. Used for command.invalid hints and by the catalog. A path past what the schema
 * describes stops at the deepest part it does; an unknown `op` gives the list of ops.
 *
 * @example
 * opJsonSchema(manifest, "addStep", ["at"]) // { anyOf: [{ type: "object", properties: { after: … } }, …] }
 */
export function opJsonSchema(
  manifest: Manifest | undefined,
  op: string,
  path: (string | number)[],
): JSONSchema {
  const b = built(manifest, false);
  let schema = opSchema(b, op);
  for (const seg of path) {
    const next = stepInto(schema, seg);
    if (!next) break;
    schema = recursiveTarget(b, next);
  }
  return fitHint(recursiveTarget(b, schema));
}

/**
 * `schema`, or the fragment schema when it is a `#recursive:` marker: compacting cuts the
 * fragment's self-reference (`branches` of fragments) to a marker, and fragments are the only
 * recursive command schema.
 */
function recursiveTarget(b: Built, schema: JSONSchema): JSONSchema {
  const ref = schema.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#recursive:")) return schema;
  b.fragmentJson ??= compactSchema(
    tidy(z.toJSONSchema(b.fragment, { unrepresentable: "any" })) as JSONSchema,
  );
  return b.fragmentJson;
}

/** @internal `schema` cut to fit a hint (≤ 1500 chars): long enums cut, then deep subtrees. */
export function fitSchemaHint(schema: JSONSchema): JSONSchema {
  return fitHint(schema);
}

/** `commands[2].config.to`, `commands[0].steps[1]`, `commands[0].config["a-b"]`. */
export function formatPath(segments: readonly (string | number)[]): string {
  let out = "";
  for (const seg of segments) {
    if (typeof seg === "number") out += `[${seg}]`;
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seg)) out += out === "" ? seg : `.${seg}`;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}

type Issue = z.core.$ZodIssue;
type Path = (string | number)[];

/** Issues with union issues replaced by their best-matching member's, where one fits best. */
function flatten(issues: readonly Issue[], prefix: Path): { path: Path; issue: Issue }[] {
  const out: { path: Path; issue: Issue }[] = [];
  for (const issue of issues) {
    const path = [...prefix, ...(issue.path as Path)];
    if (issue.code === "invalid_union" && issue.errors.length > 0) {
      const options = issue.errors
        .map((errs) => flatten(errs, path))
        .sort((a, b) => a.length - b.length);
      const [best, second] = options;
      if (best && (!second || best.length < second.length)) {
        out.push(...best);
        continue;
      }
    }
    out.push({ path, issue });
  }
  return out;
}

function valueAt(v: unknown, path: Path): unknown {
  let cur = v;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

/** One shape issue as an {@link ApplyError}. */
function toError(
  manifest: Manifest | undefined,
  index: number,
  cmd: Record<string, unknown>,
  op: string,
  path: Path,
  issue: Issue,
): ApplyError {
  const value = valueAt(cmd, path);
  const last = path[path.length - 1];
  const fullPath = formatPath(["commands", index, ...path]);
  if (issue.code === "invalid_value" && last === "type" && typeof value === "string") {
    const trigger = op === "setTrigger" && path.length === 1;
    const code: CommandErrorCode = trigger ? "trigger.unknown" : "node.unknown";
    const types = trigger
      ? (manifest?.triggers ?? []).map((t) => t.type)
      : (manifest?.nodes ?? []).map((n) => n.type);
    return {
      index,
      path: fullPath,
      code,
      message: `Unknown ${trigger ? "trigger" : "node"} type "${value}"`,
      hint: { closest: closest(value, types, 10) },
    };
  }
  const missing = value === undefined && path.length > 0 && issue.code !== "unrecognized_keys";
  const message = missing
    ? `Missing required field "${String(last)}"`
    : issue.code === "invalid_union"
      ? "Invalid value: it matches none of the allowed forms (see hint)"
      : issue.message;
  const hintPath = missing ? path.slice(0, -1) : path;
  return {
    index,
    path: fullPath,
    code: "command.invalid",
    message,
    hint: { expected: opJsonSchema(manifest, op, hintPath) },
  };
}

/**
 * @internal The shape errors of `commands[index]` against the command schema (the internal one
 * unless `internal: false`), in path order (none when it is well-formed).
 */
export function shapeErrors(
  manifest: Manifest | undefined,
  cmd: unknown,
  index: number,
  internal = true,
): ApplyError[] {
  const b = built(manifest, internal);
  if (!isObject(cmd)) {
    return [
      {
        index,
        path: `commands[${index}]`,
        code: "command.invalid",
        message: "A command must be an object with an op",
        hint: { expected: opJsonSchema(manifest, "", []) },
      },
    ];
  }
  const op = cmd.op;
  const members = typeof op === "string" ? b.members.get(op) : undefined;
  if (!members) {
    return [
      {
        index,
        path: `commands[${index}].op`,
        code: "command.invalid",
        message:
          op === undefined ? 'Missing required field "op"' : `Unknown op ${JSON.stringify(op)}`,
        hint: { expected: opJsonSchema(manifest, "", []) },
      },
    ];
  }
  const parsed = memberFor(op as string, members, cmd).safeParse(cmd);
  if (parsed.success) return [];
  return flatten(parsed.error.issues, []).map(({ path, issue }) =>
    toError(manifest, index, cmd, op as string, path, issue),
  );
}
