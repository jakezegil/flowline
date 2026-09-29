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

/** What an in-progress `$ref` (one being expanded higher up) is replaced with. */
const RECURSIVE: JSONSchema = { $ref: "#recursive" };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function compactUi(meta: unknown): Record<string, unknown> | undefined {
  if (!isObject(meta)) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of UI_KEPT) if (meta[k] !== undefined) out[k] = meta[k];
  return Object.keys(out).length > 0 ? out : undefined;
}

function compact(root: JSONSchema, node: unknown, expanding: readonly string[]): unknown {
  if (typeof node === "boolean") return node;
  if (!isObject(node)) return {};
  let schema = node as JSONSchema;
  let stack = expanding;
  if (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    if (stack.includes(ref)) return RECURSIVE;
    stack = [...stack, ref];
    schema = derefSchema(root, schema);
    // A chain that ends in a ref already being expanded.
    if (typeof schema.$ref === "string") return RECURSIVE;
  }
  const out: JSONSchema = {};
  for (const [k, v] of Object.entries(schema)) {
    if (DROPPED.has(k)) continue;
    if (k === UI_META_KEY) {
      const ui = compactUi(v);
      if (ui) out[k] = ui;
    } else if (ONE.has(k)) {
      out[k] = compact(root, v, stack);
    } else if (LIST.has(k) && Array.isArray(v)) {
      out[k] = v.map((x) => compact(root, x, stack));
    } else if (MAP.has(k) && isObject(v)) {
      out[k] = Object.fromEntries(
        Object.entries(v).map(([name, x]) => [name, compact(root, x, stack)]),
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * `schema` trimmed for a model: local `$ref`s into `$defs` resolved inline (a ref met again
 * inside its own expansion, i.e. a cycle, becomes `{"$ref":"#recursive"}`), `x-flowline` reduced
 * to `{ label, widget, enumLabels }` (dropped when none is set), and `title`, `$schema`, `$id`,
 * `$comment` and `$defs` left out. The input is not modified.
 *
 * @example
 * compactSchema(node.input) // { type: "object", properties: { to: { type: "string" } }, … }
 */
export function compactSchema(schema: JSONSchema): JSONSchema {
  return compact(schema, schema, []) as JSONSchema;
}
