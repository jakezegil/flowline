/**
 * Schema-driven masking of sensitive values before they are journaled or emitted as events.
 *
 * @module
 */
import { type JSONSchema, UI_META_KEY } from "@flowkit/core";

/** The value that replaces masked fields. */
export const REDACTED = "[redacted]";

const MAX_DEPTH = 64;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isMasked(schema: JSONSchema): boolean {
  const meta = schema[UI_META_KEY];
  return isObject(meta) && (meta.secret === true || meta.sensitive === true);
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

function redactAt(value: unknown, raw: unknown, root: JSONSchema, depth: number): unknown {
  if (!isObject(raw) || depth > MAX_DEPTH) return value;
  const schema = deref(root, raw);
  if (isMasked(schema)) return value === undefined ? value : REDACTED;

  let out = value;
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const members = schema[key];
    if (Array.isArray(members)) {
      for (const m of members) out = redactAt(out, m, root, depth + 1);
    }
  }

  if (Array.isArray(out)) {
    const items = schema.items;
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    if (!isObject(items) && prefix.length === 0) return out;
    return out.map((v, i) => redactAt(v, i < prefix.length ? prefix[i] : items, root, depth + 1));
  }

  if (isObject(out)) {
    const props = isObject(schema.properties) ? schema.properties : {};
    const extra = schema.additionalProperties;
    let copy: Record<string, unknown> | undefined;
    for (const [k, v] of Object.entries(out)) {
      const sub = Object.hasOwn(props, k) ? props[k] : extra;
      const next = redactAt(v, sub, root, depth + 1);
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
 * Replace every value whose JSON Schema carries `"x-flowkit": { secret: true }` or
 * `{ sensitive: true }` with {@link REDACTED}. Follows object properties, record values
 * (`additionalProperties`), array items, unions and local `$ref`s. Returns `value` itself when
 * nothing is masked; never mutates it.
 *
 * @param value The value to mask (a step's input or output).
 * @param schema The JSON Schema describing `value`.
 */
export function redactBySchema(value: unknown, schema: JSONSchema): unknown {
  return redactAt(value, schema, schema, 0);
}
