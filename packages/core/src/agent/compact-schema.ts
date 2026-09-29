/**
 * JSON Schemas trimmed for a model to read: refs inlined, editor-only metadata dropped.
 *
 * @module
 */
import { derefSchema } from "../json-schema";
import type { JSONSchema } from "../types";
import { UI_META_KEY } from "../ui";

/** Keywords whose value is one subschema. */
const ONE = new Set([
  "items",
  "additionalProperties",
  "additionalItems",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
]);
/** Keywords whose value is a list of subschemas. */
const LIST = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
/** Keywords whose value maps names to subschemas. */
const MAP = new Set(["properties", "patternProperties", "dependentSchemas"]);
/** Keywords left out of a compact schema. */
const DROPPED = new Set(["title", "$schema", "$id", "$defs", "definitions", "$comment"]);
/** The `x-flowline` keys a model needs. */
const UI_KEPT = ["label", "widget", "enumLabels"] as const;

/** Past this many characters, deeper subtrees are replaced with {@link TRUNCATED}. */
const SIZE_MAX = 20_000;
/** A build that visits more schema nodes than this is abandoned as too large. */
const NODES_MAX = 20_000;
/** What a subtree left out by the size guard is replaced with. */
const TRUNCATED: JSONSchema = { $ref: "#truncated" };

/** The name a cycle marker gives its target: the last pointer segment, or `root` for `#`. */
function refName(ref: string): string {
  const name = ref
    .slice(ref.lastIndexOf("/") + 1)
    .replace(/~1/g, "/")
    .replace(/~0/g, "~");
  return name === "" || name === "#" ? "root" : name;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function compactUi(meta: unknown): Record<string, unknown> | undefined {
  if (!isObject(meta)) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of UI_KEPT) if (meta[k] !== undefined) out[k] = meta[k];
  return Object.keys(out).length > 0 ? out : undefined;
}

class TooLarge extends Error {}

interface Walk {
  root: JSONSchema;
  /** Subschemas deeper than this become {@link TRUNCATED}. */
  maxDepth: number;
  nodes: number;
  truncated: boolean;
}

function compact(w: Walk, node: unknown, expanding: readonly string[], depth: number): unknown {
  if (typeof node === "boolean") return node;
  if (!isObject(node)) return {};
  if (depth > w.maxDepth) {
    w.truncated = true;
    return TRUNCATED;
  }
  if (++w.nodes > NODES_MAX) throw new TooLarge();
  let schema = node as JSONSchema;
  let stack = expanding;
  if (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    if (stack.includes(ref)) return { $ref: `#recursive:${refName(ref)}` };
    stack = [...stack, ref];
    schema = derefSchema(w.root, schema);
  }
  const out: JSONSchema = {};
  const sub = (x: unknown) => compact(w, x, stack, depth + 1);
  for (const [k, v] of Object.entries(schema)) {
    if (DROPPED.has(k)) continue;
    if (k === UI_META_KEY) {
      const ui = compactUi(v);
      if (ui) out[k] = ui;
    } else if (k === "items" && Array.isArray(v)) {
      // A draft-07 tuple: its 2020-12 form is `prefixItems`, with `additionalItems` as `items`.
      out.prefixItems = v.map(sub);
    } else if (k === "additionalItems") {
      if (Array.isArray(schema.items)) out.items = sub(v);
    } else if (ONE.has(k)) {
      out[k] = sub(v);
    } else if (LIST.has(k) && Array.isArray(v)) {
      out[k] = v.map(sub);
    } else if (MAP.has(k) && isObject(v)) {
      out[k] = Object.fromEntries(Object.entries(v).map(([name, x]) => [name, sub(x)]));
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** The compact form with subtrees below `maxDepth` truncated, or `undefined` when too large. */
function attempt(
  schema: JSONSchema,
  maxDepth: number,
): { schema: JSONSchema; size: number; truncated: boolean } | undefined {
  const w: Walk = { root: schema, maxDepth, nodes: 0, truncated: false };
  try {
    const out = compact(w, schema, [], 0) as JSONSchema;
    return { schema: out, size: JSON.stringify(out).length, truncated: w.truncated };
  } catch (e) {
    if (e instanceof TooLarge) return undefined;
    throw e;
  }
}

/**
 * `schema` trimmed for a model:
 * - local `$ref`s into `$defs` are resolved inline; a ref met again inside its own expansion (a
 *   cycle) becomes `{"$ref":"#recursive:<name>"}`, naming the def it points back to (`root` for
 *   `#`);
 * - `x-flowline` is reduced to `{ label, widget, enumLabels }` (dropped when none is set);
 * - `title`, `$schema`, `$id`, `$comment` and `$defs` are left out;
 * - a draft-07 tuple (`items: [...]`, `additionalItems`) becomes `prefixItems` (and `items`).
 *
 * The result stays under 20 000 characters where it can: past that, subschemas below the deepest
 * level that fits become `{"$ref":"#truncated"}`. The input is not modified.
 *
 * @example
 * compactSchema(node.input) // { type: "object", properties: { to: { type: "string" } }, … }
 */
export function compactSchema(schema: JSONSchema): JSONSchema {
  const whole = attempt(schema, Number.POSITIVE_INFINITY);
  if (whole && whole.size <= SIZE_MAX) return whole.schema;
  // Too large: the deepest cut-off that fits.
  let best = attempt(schema, 0) as { schema: JSONSchema };
  for (let depth = 1; ; depth++) {
    const r = attempt(schema, depth);
    if (!r || r.size > SIZE_MAX) break;
    best = r;
    if (!r.truncated) break;
  }
  return best.schema;
}
