/**
 * Schema-driven masking of sensitive values before they are journaled or emitted as events.
 *
 * @module
 */
import { type JSONSchema, UI_META_KEY } from "@flowlinejs/core";

/** The value that replaces masked fields. */
export const REDACTED = "[redacted]";

const MAX_DEPTH = 64;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Which fields to mask: `"secret"` masks only `secret` fields (what the journal stores, so
 * downstream references still see `sensitive` values); `"all"` also masks `sensitive` fields (what
 * events carry).
 */
export type MaskMode = "secret" | "all";

function isMasked(schema: JSONSchema, mode: MaskMode): boolean {
  const meta = schema[UI_META_KEY];
  if (!isObject(meta)) return false;
  return meta.secret === true || (mode === "all" && meta.sensitive === true);
}

/** Follows a local `#/$defs/...` or `#/definitions/...` reference against `root`. */
function deref(root: JSONSchema, schema: JSONSchema): JSONSchema {
  let cur = schema;
  for (let i = 0; i < MAX_DEPTH && typeof cur.$ref === "string"; i++) {
    const ref = cur.$ref;
    if (!ref.startsWith("#")) return cur;
    let target: unknown = root;
    for (const token of ref.slice(1).split("/").filter(Boolean)) {
      if (!isObject(target) || !Object.hasOwn(target, token)) return cur;
      target = target[token.replace(/~1/g, "/").replace(/~0/g, "~")];
    }
    if (!isObject(target)) return cur;
    const { $ref: _ref, ...rest } = cur;
    cur = { ...target, ...rest };
  }
  return cur;
}

function redactAt(
  value: unknown,
  raw: unknown,
  root: JSONSchema,
  mode: MaskMode,
  depth: number,
): unknown {
  if (!isObject(raw) || depth > MAX_DEPTH) return value;
  const schema = deref(root, raw);
  if (isMasked(schema, mode)) return value === undefined ? value : REDACTED;

  let out = value;
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const members = schema[key];
    if (Array.isArray(members)) {
      for (const m of members) out = redactAt(out, m, root, mode, depth + 1);
    }
  }

  if (Array.isArray(out)) {
    const items = schema.items;
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    if (!isObject(items) && prefix.length === 0) return out;
    return out.map((v, i) =>
      redactAt(v, i < prefix.length ? prefix[i] : items, root, mode, depth + 1),
    );
  }

  if (isObject(out)) {
    const props = isObject(schema.properties) ? schema.properties : {};
    const extra = schema.additionalProperties;
    let copy: Record<string, unknown> | undefined;
    for (const [k, v] of Object.entries(out)) {
      const sub = Object.hasOwn(props, k) ? props[k] : extra;
      const next = redactAt(v, sub, root, mode, depth + 1);
      if (next !== v) {
        copy ??= { ...out };
        Object.defineProperty(copy, k, {
          value: next,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    return copy ?? out;
  }
  return out;
}

/**
 * Replace every value whose JSON Schema carries `"x-flowline": { secret: true }` (and, with
 * `mask: "all"`, `{ sensitive: true }`) with {@link REDACTED}. Follows object properties, record values
 * (`additionalProperties`), array items, unions and local `$ref`s. Returns `value` itself when
 * nothing is masked; never mutates it.
 *
 * @param value The value to mask (a step's input or output).
 * @param schema The JSON Schema describing `value`.
 * @param opts `mask`: which fields to mask (see {@link MaskMode}).
 */
export function redactBySchema(
  value: unknown,
  schema: JSONSchema,
  opts: { mask: MaskMode },
): unknown {
  return redactAt(value, schema, schema, opts.mask, 0);
}
