/**
 * JSON Schema helpers for the config form: dereferencing, choosing a control per schema, labels,
 * discriminated unions, defaults, issue lookup and invalid references.
 *
 * @module
 */
import {
  collectRefs,
  type Issue,
  isAnySchema,
  type JSONSchema,
  parseRefPath,
  type ScopeEntry,
  schemaAtPath,
  UI_META_KEY,
  type UiMeta,
  type ValueExpr,
} from "@flowline/core";

const MAX_DEPTH = 32;

function asSchema(v: unknown): JSONSchema {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as JSONSchema) : {};
}

function decodePointer(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Follows local `$ref`s (`#/$defs/X`) against `root`, keeping sibling keywords. */
export function deref(root: JSONSchema, schema: unknown): JSONSchema {
  let cur = asSchema(schema);
  for (let depth = 0; typeof cur.$ref === "string"; depth++) {
    const ref = cur.$ref as string;
    if (depth >= MAX_DEPTH || !ref.startsWith("#")) return {};
    let target: unknown = root;
    const pointer = ref.slice(1);
    if (pointer !== "") {
      for (const token of pointer.slice(1).split("/")) {
        if (typeof target !== "object" || target === null) return {};
        target = (target as Record<string, unknown>)[decodePointer(token)];
      }
    }
    if (target === undefined) return {};
    const { $ref: _ignored, ...rest } = cur;
    cur = Object.keys(rest).length === 0 ? asSchema(target) : { ...asSchema(target), ...rest };
  }
  return cur;
}

/** The field's editor hints (`x-flowline`), `{}` when none. */
export function metaOf(schema: JSONSchema | undefined): UiMeta {
  const meta = schema?.[UI_META_KEY];
  return typeof meta === "object" && meta !== null ? (meta as UiMeta) : {};
}

const ACRONYMS = new Set(["id", "url", "uri", "api", "http", "json", "html", "ip", "sms", "ms"]);

/** `"timeoutMs"` → `"Timeout ms"`, `"api_key"` → `"API key"`. */
export function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.toLowerCase()));
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Display text of an enum value: its `x-flowline.enumLabels` entry (keyed by the value as a
 * string) when `meta` has one, else the value as written unless it is a lowercase word.
 */
export function optionLabel(value: unknown, meta?: UiMeta): string {
  const custom = meta?.enumLabels?.[typeof value === "string" ? value : JSON.stringify(value)];
  if (typeof custom === "string" && custom !== "") return custom;
  if (typeof value !== "string") return JSON.stringify(value);
  if (value === "") return "(empty)";
  if (/^[a-z][a-zA-Z0-9_-]*$/.test(value)) return humanize(value);
  return value;
}

/** A field's label: `x-flowline.label`, else `title`, else the humanized key. */
export function labelOf(schema: JSONSchema, key: string): string {
  const meta = metaOf(schema);
  if (typeof meta.label === "string" && meta.label !== "") return meta.label;
  if (typeof schema.title === "string" && schema.title !== "") return schema.title;
  return humanize(key);
}

/** `type` as a list, or `undefined` when unconstrained. */
export function typesOf(schema: JSONSchema): string[] | undefined {
  if (typeof schema.type === "string") return [schema.type];
  if (Array.isArray(schema.type)) return schema.type.filter((t) => typeof t === "string");
  return undefined;
}

function isNullSchema(s: JSONSchema): boolean {
  return s.type === "null" || ("const" in s && s.const === null);
}

/** Members of `anyOf`/`oneOf`, dereferenced, or `undefined` if not a union. */
export function unionMembers(root: JSONSchema, schema: JSONSchema): JSONSchema[] | undefined {
  const list = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  return list?.map((m) => deref(root, m));
}

/**
 * The schema with nullability stripped: `anyOf [T, null]` → `T` (with the outer annotations),
 * and `type: ["string", "null"]` → `type: "string"`.
 */
export function unwrapNullable(root: JSONSchema, schema: JSONSchema): JSONSchema {
  const s = deref(root, schema);
  const members = unionMembers(root, s);
  if (members) {
    const rest = members.filter((m) => !isNullSchema(m));
    if (rest.length === 1 && rest[0]) {
      const { anyOf: _a, oneOf: _o, ...outer } = s;
      return { ...rest[0], ...outer, [UI_META_KEY]: { ...metaOf(rest[0]), ...metaOf(s) } };
    }
  }
  const types = typesOf(s);
  if (types && types.length === 2 && types.includes("null")) {
    return { ...s, type: types.find((t) => t !== "null") };
  }
  return s;
}

/** One option of a discriminated union. */
export interface UnionVariant {
  /** The discriminator's value for this variant. */
  value: string | number | boolean;
  /** The variant's object schema. */
  schema: JSONSchema;
  label: string;
}

/** A union of objects told apart by a constant property (e.g. `type`). */
export interface DiscriminatedUnion {
  key: string;
  variants: UnionVariant[];
}

function constOf(root: JSONSchema, prop: unknown): { ok: boolean; value?: unknown } {
  const s = deref(root, prop);
  if ("const" in s) return { ok: true, value: s.const };
  if (Array.isArray(s.enum) && s.enum.length === 1) return { ok: true, value: s.enum[0] };
  return { ok: false };
}

/**
 * Detects a discriminated union: every member is an object with a property holding a distinct
 * constant (`{ type: { const: "bearer" } }`). Prefers a property named `type` or `kind`.
 */
export function discriminatedUnion(
  root: JSONSchema,
  schema: JSONSchema,
): DiscriminatedUnion | undefined {
  const members = unionMembers(root, schema)?.filter((m) => !isNullSchema(m));
  if (!members || members.length < 2) return undefined;
  const propsOf = (m: JSONSchema) =>
    typeof m.properties === "object" && m.properties !== null
      ? (m.properties as Record<string, unknown>)
      : undefined;
  const first = propsOf(members[0] as JSONSchema);
  if (!first) return undefined;
  const candidates = Object.keys(first).sort((a, b) => rank(a) - rank(b));
  for (const key of candidates) {
    const values: unknown[] = [];
    const ok = members.every((m) => {
      const c = constOf(root, propsOf(m)?.[key]);
      const v = c.value;
      if (!c.ok || !["string", "number", "boolean"].includes(typeof v)) return false;
      if (values.includes(v)) return false;
      values.push(v);
      return true;
    });
    if (!ok) continue;
    return {
      key,
      variants: members.map((m, i) => {
        const value = values[i] as string | number | boolean;
        const title = metaOf(m).label ?? (typeof m.title === "string" ? m.title : undefined);
        return { value, schema: m, label: title ?? optionLabel(value) };
      }),
    };
  }
  return undefined;
}

function rank(key: string): number {
  return key === "type" ? 0 : key === "kind" ? 1 : 2;
}

/** How a field is edited. */
export type FieldKind =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "array"
  | "object"
  | "map"
  | "union"
  | "any";

/** The control kind for a (dereferenced, nullability-stripped) schema. */
export function fieldKind(root: JSONSchema, schema: JSONSchema): FieldKind {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return "enum";
  if ("const" in schema) return "enum";
  if (unionMembers(root, schema)) return discriminatedUnion(root, schema) ? "union" : "any";
  const types = typesOf(schema);
  const type = types?.length === 1 ? types[0] : undefined;
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "array";
    case "object": {
      const props = schema.properties as Record<string, unknown> | undefined;
      if (props && Object.keys(props).length > 0) return "object";
      return "map";
    }
    default:
      if (schema.properties) return "object";
      if (schema.items) return "array";
      return "any";
  }
}

/** Whether `schema` accepts anything (`{}` or annotations only). */
export function isAny(schema: JSONSchema): boolean {
  return isAnySchema(schema);
}

/** Property schemas of an object schema, in declaration order. */
export function propertiesOf(schema: JSONSchema): [string, JSONSchema][] {
  const props = schema.properties;
  if (typeof props !== "object" || props === null) return [];
  return Object.entries(props as Record<string, unknown>).map(([k, v]) => [k, asSchema(v)]);
}

/** Required property names of an object schema. */
export function requiredOf(schema: JSONSchema): Set<string> {
  return new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
}

/** The `items` schema of an array schema (dereferenced), `{}` when unconstrained. */
export function itemsOf(root: JSONSchema, schema: JSONSchema): JSONSchema {
  return unwrapNullable(root, deref(root, schema.items));
}

/** The value schema of a map (`additionalProperties`), `{}` when unconstrained. */
export function mapValueOf(root: JSONSchema, schema: JSONSchema): JSONSchema {
  const extra = schema.additionalProperties;
  return extra && typeof extra === "object" ? unwrapNullable(root, deref(root, extra)) : {};
}

/**
 * A fresh value for a new array item or union variant: the schema's `default`, else an object of
 * its properties' defaults (plus the discriminator), else `undefined`.
 */
export function initialValue(root: JSONSchema, schema: JSONSchema): ValueExpr | undefined {
  const s = unwrapNullable(root, schema);
  if (s.default !== undefined) return structuredClone(s.default) as ValueExpr;
  if ("const" in s) return s.const as ValueExpr;
  const kind = fieldKind(root, s);
  if (kind === "object") {
    const out: Record<string, ValueExpr> = {};
    for (const [key, prop] of propertiesOf(s)) {
      const v = initialValue(root, prop);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }
  if (kind === "union") {
    const u = discriminatedUnion(root, s);
    const first = u?.variants[0];
    return first ? initialValue(root, first.schema) : undefined;
  }
  return undefined;
}

/** `a` + `b` → `"a.b"`; empty parent → `"b"`. */
export function childPath(parent: string, key: string): string {
  return parent === "" ? key : `${parent}.${key}`;
}

/** `"cc"` + 1 → `"cc[1]"`. */
export function itemPath(parent: string, index: number): string {
  return `${parent}[${index}]`;
}

/** Issues reported exactly at `path`. */
export function issuesAt(issues: readonly Issue[], path: string): Issue[] {
  return issues.filter((i) => i.field === path);
}

/** Issues at `path` or anywhere inside it (`path.x`, `path[0]`). */
export function issuesUnder(issues: readonly Issue[], path: string): Issue[] {
  return issues.filter(
    (i) =>
      i.field !== undefined &&
      (i.field === path || i.field.startsWith(`${path}.`) || i.field.startsWith(`${path}[`)),
  );
}

/** The top-level config key an issue's field points into (`"rules.rules[0]"` → `"rules"`). */
export function topKey(field: string): string {
  const m = /^[^.[]+/.exec(field);
  return m ? m[0] : field;
}

/**
 * Reference paths in `value` that don't resolve against `scope`: unknown roots or steps, or
 * fields that the referenced value's schema doesn't have.
 */
export function invalidRefsIn(value: ValueExpr | undefined, scope: ScopeEntry[]): Set<string> {
  const out = new Set<string>();
  if (value === undefined) return out;
  for (const ref of collectRefs(value)) {
    if (!refResolves(ref, scope)) out.add(ref);
  }
  return out;
}

function refResolves(ref: string, scope: ScopeEntry[]): boolean {
  return refSchema(ref, scope) !== undefined;
}

/**
 * The schema of the value a reference path points to, or `undefined` when it doesn't resolve.
 * `run.*` paths are strings.
 */
export function refSchema(ref: string, scope: ScopeEntry[]): JSONSchema | undefined {
  try {
    const path = parseRefPath(ref);
    if (path.root === "run") return { type: "string" };
    const base = path.root === "steps" ? `steps.${path.stepId}` : path.root;
    const entry = [...scope].reverse().find((e) => e.refBase === base);
    if (!entry) return undefined;
    return schemaAtPath(entry.schema, path.segments);
  } catch {
    return undefined;
  }
}

/** Whether a value is "empty" for display purposes (unset, blank text, empty list/object). */
export function isBlank(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}
