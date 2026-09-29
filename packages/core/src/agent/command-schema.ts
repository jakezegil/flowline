/**
 * Strict Zod schemas of the commands, their JSON Schemas for hints and the tool catalog, and the
 * shape check `apply` runs before any command.
 *
 * @module
 */
import { z } from "zod";
import { ANNOTATION_COLORS } from "../annotations";
import type { AnnotationColor, JSONSchema, Manifest } from "../types";
import { type ApplyError, type Command, type CommandErrorCode, closest } from "./commands";
import { compactSchema } from "./compact-schema";

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
}

function build(manifest: Manifest | undefined, internal: boolean): Built {
  const stepRef = z.string().min(1);
  const at = z.union([
    z.strictObject({ after: stepRef }),
    z.strictObject({ before: stepRef }),
    z.strictObject({
      in: z.strictObject({ stepId: stepRef, branch: z.string().min(1) }),
      index: z.number().int().min(0).optional(),
    }),
    z.strictObject({ start: z.literal(true) }),
  ]);
  const nodeTypes = manifest?.nodes.map((n) => n.type) ?? [];
  const nodeType =
    nodeTypes.length > 0 ? z.enum(nodeTypes as [string, ...string[]]) : z.string().min(1);
  const color = z.enum(ANNOTATION_COLORS as unknown as [AnnotationColor, ...AnnotationColor[]]);
  const json = jsonValue();
  const members = new Map<string, z.ZodType[]>([
    [
      "addStep",
      [
        z.strictObject({
          op: z.literal("addStep"),
          at,
          type: nodeType,
          id: z.string().optional(),
          name: z.string().optional(),
          config: z.record(z.string(), json).optional(),
          note: z.string().optional(),
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
  ]);
  const all = [...members.values()].flat();
  const union = z.union(all as [z.ZodType, z.ZodType, ...z.ZodType[]]) as z.ZodType<Command>;
  return { members, union, json: new Map() };
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
  let schema = opSchema(built(manifest, false), op);
  for (const seg of path) {
    const next = stepInto(schema, seg);
    if (!next) break;
    schema = next;
  }
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
 * @internal The shape errors of `commands[index]` against the internal command schema, in path
 * order (none when it is well-formed).
 */
export function shapeErrors(
  manifest: Manifest | undefined,
  cmd: unknown,
  index: number,
): ApplyError[] {
  const b = built(manifest, true);
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
  // An op with two forms (setConfig): the `config` key picks the merge form.
  const schema =
    members.length > 1 && !("config" in cmd) ? members[0] : members[members.length - 1];
  const parsed = (schema as z.ZodType).safeParse(cmd);
  if (parsed.success) return [];
  return flatten(parsed.error.issues, []).map(({ path, issue }) =>
    toError(manifest, index, cmd, op as string, path, issue),
  );
}
