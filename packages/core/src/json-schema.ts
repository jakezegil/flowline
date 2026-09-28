import { isRef, isTpl } from "./refs";
import type { ValidationContext } from "./scope";
import type {
  FieldDecl,
  FieldType,
  JSONSchema,
  NodeManifest,
  Step,
  TriggerConfig,
  TriggerManifest,
  UiMeta,
  ValueExpr,
} from "./types";
import { UI_META_KEY } from "./ui";

const FIELD_TYPE_SCHEMA: Record<FieldType, JSONSchema> = {
  string: { type: "string" },
  number: { type: "number" },
  boolean: { type: "boolean" },
  object: { type: "object" },
  array: { type: "array" },
  date: { type: "string", format: "date-time" },
};

/**
 * Build the JSON Schema of an object whose properties are the given user-declared fields.
 * `date` fields become `{ type: "string", format: "date-time" }`. Extra properties are allowed
 * unless `closed` is set (`additionalProperties: false`). The validator resolves references into
 * trigger input fields, declared webhook bodies and sub-flow inputs and outputs as closed, so a
 * reference to an undeclared field is an error there.
 *
 * @example
 * ```ts
 * fieldsToJsonSchema([{ name: "a", type: "date", required: true }]);
 * // { type: "object", properties: { a: { type: "string", format: "date-time" } },
 * //   required: ["a"], additionalProperties: true }
 * ```
 */
export function fieldsToJsonSchema(
  fields: FieldDecl[],
  opts: { closed?: boolean } = {},
): JSONSchema {
  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];
  for (const field of fields) {
    properties[field.name] = {
      ...FIELD_TYPE_SCHEMA[field.type],
      ...(field.description === undefined ? {} : { description: field.description }),
    };
    if (field.required && !required.includes(field.name)) required.push(field.name);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: opts.closed !== true,
  };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Runtime value checks per {@link FieldType}, matching {@link fieldsToJsonSchema}. */
const FIELD_VALUE_CHECKS: Record<FieldType, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  object: isPlainObject,
  array: Array.isArray,
  date: (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)),
};

/**
 * Check `value` against user-declared fields: it must be an object, every `required` field must
 * be present (not `undefined`), and present fields must have their declared type (`date` = a
 * parseable date string). Extra properties are allowed, as in {@link fieldsToJsonSchema};
 * malformed declarations are ignored.
 *
 * @returns Why the value does not match (e.g. `field "email" is required`), or `undefined`.
 *
 * @example
 * ```ts
 * checkFields([{ name: "n", type: "number", required: true }], { n: "1" });
 * // 'field "n" must be of type number'
 * ```
 */
export function checkFields(fields: readonly FieldDecl[], value: unknown): string | undefined {
  if (!isPlainObject(value)) return "must be an object";
  for (const field of fields) {
    const check = isPlainObject(field) ? FIELD_VALUE_CHECKS[field.type] : undefined;
    if (!check || typeof field.name !== "string") continue;
    const v = Object.hasOwn(value, field.name) ? value[field.name] : undefined;
    if (v === undefined) {
      if (field.required === true) return `field "${field.name}" is required`;
    } else if (!check(v)) {
      return `field "${field.name}" must be of type ${field.type}`;
    }
  }
  return undefined;
}

/** Keys that constrain a schema. A schema with none of them accepts any JSON value. */
const CONSTRAINT_KEYS = [
  "type",
  "properties",
  "items",
  "prefixItems",
  "additionalProperties",
  "patternProperties",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "$ref",
  "enum",
  "const",
] as const;

/**
 * True if `schema` accepts any value: `{}`, `true`, or a schema carrying only annotations
 * (`description`, `default`, `"x-flowline"`, …). Undeclared node outputs and trigger payloads are `{}`.
 */
export function isAnySchema(schema: unknown): boolean {
  if (schema === true || schema === undefined) return true;
  if (typeof schema !== "object" || schema === null) return false;
  for (const key of CONSTRAINT_KEYS) {
    if (key in schema) return false;
  }
  return true;
}

const MAX_REF_DEPTH = 32;

/**
 * @internal Normalizes a raw subschema: `true`/missing/garbage → `{}` (any, lenient), `false` →
 * `{ not: {} }` (nothing matches, e.g. `items: false` after a Zod tuple).
 */
export function asSchema(v: unknown): JSONSchema {
  if (v === false) return { not: {} };
  if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as JSONSchema;
  return {};
}

function decodePointer(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Follows local `$ref`s (`#`, `#/$defs/X`, `#/definitions/X`) against `root`. Unresolvable → `{}`. */
function deref(root: JSONSchema, schema: JSONSchema): JSONSchema {
  let cur = asSchema(schema);
  for (let depth = 0; typeof cur.$ref === "string"; depth++) {
    if (depth >= MAX_REF_DEPTH) return {};
    const ref = cur.$ref as string;
    if (!ref.startsWith("#")) return {};
    let target: unknown = root;
    const pointer = ref.slice(1);
    if (pointer !== "") {
      if (!pointer.startsWith("/")) return {};
      for (const token of pointer.slice(1).split("/")) {
        if (typeof target !== "object" || target === null) return {};
        target = (target as Record<string, unknown>)[decodePointer(token)];
      }
    }
    if (target === undefined) return {};
    const { $ref: _ignored, ...rest } = cur;
    const resolved = asSchema(target);
    // Sibling keywords next to `$ref` (e.g. `description`, `"x-flowline"`) are kept.
    cur = Object.keys(rest).length === 0 ? resolved : { ...resolved, ...rest };
  }
  return cur;
}

/** @internal Makes a subschema self-contained by carrying the root's `$defs`/`definitions` along. */
export function carryDefs(root: JSONSchema, sub: JSONSchema): JSONSchema {
  if (sub === root) return sub;
  const defs = root.$defs;
  const definitions = root.definitions;
  if (defs === undefined && definitions === undefined) return sub;
  if (!JSON.stringify(sub).includes('"$ref"')) return sub;
  return {
    ...sub,
    ...(defs !== undefined && sub.$defs === undefined ? { $defs: defs } : {}),
    ...(definitions !== undefined && sub.definitions === undefined ? { definitions } : {}),
  };
}

function typeList(schema: JSONSchema): string[] | undefined {
  const t = schema.type;
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return undefined;
}

/** Non-null members of an `anyOf`/`oneOf`, or `undefined` if the schema isn't a union. */
function unionMembers(root: JSONSchema, schema: JSONSchema): JSONSchema[] | undefined {
  const members = (schema.anyOf ?? schema.oneOf) as unknown;
  if (!Array.isArray(members)) return undefined;
  return members
    .map((m) => deref(root, asSchema(m)))
    .filter((m) => {
      const types = typeList(m);
      return !(types !== undefined && types.length === 1 && types[0] === "null");
    });
}

function isObjectish(schema: JSONSchema): boolean {
  const types = typeList(schema);
  if (types) return types.includes("object");
  return (
    schema.properties !== undefined ||
    schema.additionalProperties !== undefined ||
    schema.patternProperties !== undefined
  );
}

function isArrayish(schema: JSONSchema): boolean {
  const types = typeList(schema);
  if (types) return types.includes("array");
  return schema.items !== undefined || schema.prefixItems !== undefined;
}

function stepInto(
  root: JSONSchema,
  schema: JSONSchema,
  seg: string | number,
): JSONSchema | undefined {
  const cur = deref(root, schema);
  if (isAnySchema(cur)) return {};
  const members = unionMembers(root, cur);
  if (members) {
    const results = members
      .map((m) => stepInto(root, m, seg))
      .filter((r): r is JSONSchema => r !== undefined);
    if (results.length === 0) return undefined;
    if (results.length === 1) return results[0];
    return results.some(isAnySchema) ? {} : { anyOf: results };
  }
  if (Array.isArray(cur.allOf)) {
    for (const member of cur.allOf) {
      const r = stepInto(root, asSchema(member), seg);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  if (typeof seg === "number" && isArrayish(cur)) {
    const prefix = cur.prefixItems;
    if (Array.isArray(prefix) && seg < prefix.length) return deref(root, asSchema(prefix[seg]));
    return deref(root, asSchema(cur.items));
  }
  if (isObjectish(cur)) {
    const key = String(seg);
    const props = cur.properties as Record<string, unknown> | undefined;
    if (props && Object.hasOwn(props, key)) return deref(root, asSchema(props[key]));
    if (cur.patternProperties !== undefined) return {};
    const extra = cur.additionalProperties;
    if (extra === false) return undefined;
    return deref(root, asSchema(extra));
  }
  return undefined;
}

/**
 * The schema of the value at `segments` inside a value of `schema`, or `undefined` if the path
 * can't exist. Follows object `properties` (and `additionalProperties` for records), `items` for
 * numeric segments, nullable `anyOf`/`oneOf`, `allOf`, and local `$ref`s into `$defs`.
 *
 * Lenient where the schema is open: a missing key only fails on a closed object
 * (`additionalProperties: false`), and any path into `{}` (any) resolves to `{}`.
 * The returned subschema carries the root's `$defs`, so it can be passed on self-contained.
 *
 * @example
 * ```ts
 * schemaAtPath(contactSchema, ["orders", 0, "total"]); // { type: "number" }
 * schemaAtPath(contactSchema, ["emial"]);              // undefined
 * ```
 */
export function schemaAtPath(
  schema: JSONSchema,
  segments: (string | number)[],
): JSONSchema | undefined {
  if (segments.length === 0) return schema;
  let cur: JSONSchema = schema;
  for (const seg of segments) {
    const next = stepInto(schema, cur, seg);
    if (next === undefined) return undefined;
    cur = next;
  }
  return carryDefs(schema, cur);
}

function isSecretField(schema: JSONSchema): boolean {
  const meta = schema[UI_META_KEY];
  return typeof meta === "object" && meta !== null && (meta as UiMeta).secret === true;
}

/** Subschemas a value of `schema` may be checked against (properties, items, union members…). */
function childSchemas(schema: JSONSchema): unknown[] {
  const out: unknown[] = [];
  const props = schema.properties;
  if (typeof props === "object" && props !== null) out.push(...Object.values(props));
  for (const key of ["additionalProperties", "items", "not"] as const) out.push(schema[key]);
  for (const key of ["prefixItems", "anyOf", "oneOf", "allOf"] as const) {
    const list = schema[key];
    if (Array.isArray(list)) out.push(...list);
  }
  return out.filter((c) => typeof c === "object" && c !== null);
}

/**
 * @internal True if `schema`, or any schema nested in it, marks a {@link secret} field. A
 * reference or template standing for such a value would let run data choose the secret.
 */
export function containsSecret(root: JSONSchema, schema: JSONSchema): boolean {
  const seen = new Set<unknown>();
  const visit = (raw: unknown, depth: number): boolean => {
    if (depth > MAX_REF_DEPTH || seen.has(raw)) return false;
    seen.add(raw);
    const s = deref(root, asSchema(raw));
    if (isSecretField(s)) return true;
    if (s !== raw && seen.has(s)) return false;
    seen.add(s);
    return childSchemas(s).some((c) => visit(c, depth + 1));
  };
  return visit(schema, 0);
}

/**
 * The config path (e.g. `"auth.secret"`, `"auth"`) of the first `$ref` or `$tpl` in `config` that
 * stands for a {@link secret} field or for a value containing one; `undefined` if there is none.
 * Secret fields are literal-only: the engine refuses to run a step for which this returns a path,
 * so trigger data can never choose which secret is resolved.
 *
 * @example
 * ```ts
 * secretExprPath({ token: { $ref: "trigger.body.which" } }, manifest.input); // "token"
 * ```
 */
export function secretExprPath(
  config: Record<string, ValueExpr>,
  schema: JSONSchema,
): string | undefined {
  const visit = (value: unknown, raw: unknown, path: string, depth: number): string | undefined => {
    if (depth > MAX_REF_DEPTH) return undefined;
    const s = deref(schema, asSchema(raw));
    if (isRef(value) || isTpl(value)) return containsSecret(schema, s) ? path : undefined;
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      const members = s[key];
      if (!Array.isArray(members)) continue;
      for (const m of members) {
        const found = visit(value, m, path, depth + 1);
        if (found !== undefined) return found;
      }
    }
    if (Array.isArray(value)) {
      const prefix = Array.isArray(s.prefixItems) ? s.prefixItems : [];
      for (const [i, item] of value.entries()) {
        const found = visit(
          item,
          i < prefix.length ? prefix[i] : s.items,
          `${path}[${i}]`,
          depth + 1,
        );
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (typeof value === "object" && value !== null) {
      const props = (
        typeof s.properties === "object" && s.properties !== null ? s.properties : {}
      ) as Record<string, unknown>;
      for (const [key, v] of Object.entries(value)) {
        const sub = Object.hasOwn(props, key) ? props[key] : s.additionalProperties;
        const found = visit(v, sub, path === "" ? key : `${path}.${key}`, depth + 1);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return visit(config, schema, "", 0);
}

/** @internal JSON Schema value kinds (`integer` for whole numbers). */
export type Kind = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";

/** @internal The JSON Schema kind of a JSON value. */
export function valueKind(v: unknown): Kind {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v as Kind;
}

/** Enum values (from `enum`/`const`), or `undefined` if unconstrained. */
function enumValues(schema: JSONSchema): unknown[] | undefined {
  if ("const" in schema) return [schema.const];
  if (Array.isArray(schema.enum)) return schema.enum;
  return undefined;
}

/** The non-null value kinds a (dereferenced, non-union) schema admits; `undefined` = any. */
function kindsOf(schema: JSONSchema): Set<Kind> | undefined {
  const types = typeList(schema);
  let kinds: Kind[] | undefined;
  if (types) kinds = types as Kind[];
  else {
    const values = enumValues(schema);
    if (values) kinds = values.map(valueKind);
    else if (isObjectish(schema)) kinds = ["object"];
    else if (isArrayish(schema)) kinds = ["array"];
  }
  if (!kinds) return undefined;
  return new Set(kinds.filter((k) => k !== "null"));
}

function kindAssignable(from: Kind, to: Kind): boolean {
  if (from === to) return true;
  if (to === "number" && from === "integer") return true;
  if (to === "integer" && from === "number") return true; // runtime validates
  // Primitives coerce to strings (templates, IDs typed as numbers, …).
  if (to === "string") return from === "number" || from === "integer" || from === "boolean";
  return false;
}

function assignable(
  fromRoot: JSONSchema,
  from: JSONSchema,
  toRoot: JSONSchema,
  to: JSONSchema,
  depth: number,
): boolean {
  if (depth > MAX_REF_DEPTH) return true;
  const f = deref(fromRoot, from);
  const t = deref(toRoot, to);
  if (isAnySchema(f) || isAnySchema(t)) return true;

  const toMembers = unionMembers(toRoot, t);
  if (toMembers) {
    if (toMembers.length === 0) return true; // only `null`: nullability is ignored
    return toMembers.some((m) => assignable(fromRoot, f, toRoot, m, depth + 1));
  }
  const fromMembers = unionMembers(fromRoot, f);
  if (fromMembers) {
    if (fromMembers.length === 0) return true;
    return fromMembers.some((m) => assignable(fromRoot, m, toRoot, t, depth + 1));
  }
  if (Array.isArray(t.allOf)) {
    return t.allOf.every((m) => assignable(fromRoot, f, toRoot, asSchema(m), depth + 1));
  }
  if (Array.isArray(f.allOf)) {
    return f.allOf.some((m) => assignable(fromRoot, asSchema(m), toRoot, t, depth + 1));
  }

  const fromKinds = kindsOf(f);
  const toKinds = kindsOf(t);
  if (!fromKinds || !toKinds || fromKinds.size === 0 || toKinds.size === 0) return true;
  const pairs: [Kind, Kind][] = [];
  for (const fk of fromKinds)
    for (const tk of toKinds) if (kindAssignable(fk, tk)) pairs.push([fk, tk]);
  if (pairs.length === 0) return false;

  // Enums: every value `from` may produce must be accepted by `to`.
  const toValues = enumValues(t);
  const fromValues = enumValues(f);
  if (toValues && fromValues) {
    if (!fromValues.every((v) => toValues.some((w) => JSON.stringify(w) === JSON.stringify(v)))) {
      return false;
    }
  }

  return pairs.some(([fk, tk]) => {
    if (fk === "array" && tk === "array") {
      if (f.items === undefined || t.items === undefined) return true;
      return assignable(fromRoot, asSchema(f.items), toRoot, asSchema(t.items), depth + 1);
    }
    if (fk === "object" && tk === "object") return objectAssignable(fromRoot, f, toRoot, t, depth);
    return true;
  });
}

function objectAssignable(
  fromRoot: JSONSchema,
  f: JSONSchema,
  toRoot: JSONSchema,
  t: JSONSchema,
  depth: number,
): boolean {
  const toProps = (t.properties ?? {}) as Record<string, unknown>;
  const fromProps = f.properties as Record<string, unknown> | undefined;
  const required = Array.isArray(t.required) ? (t.required as string[]) : [];
  for (const [key, toProp] of Object.entries(toProps)) {
    const fromProp = fromProps?.[key];
    if (fromProp === undefined) {
      if (required.includes(key) && fromProps !== undefined && f.additionalProperties === false) {
        return false;
      }
      continue;
    }
    if (!assignable(fromRoot, asSchema(fromProp), toRoot, asSchema(toProp), depth + 1))
      return false;
  }
  return true;
}

/**
 * Whether a value of schema `from` may be used where `to` is expected. Structural and lenient,
 * since the runtime validates again: `{}`/any on either side is assignable; nullability and
 * optionality are ignored; numbers and booleans are assignable to strings (coercion); string enums
 * are assignable to strings and to enums containing all their values; array item types and
 * object property types are checked recursively; objects are never assignable to strings.
 */
export function isAssignable(from: JSONSchema, to: JSONSchema): boolean {
  return assignable(from, from, to, to, 0);
}

const MAX_DESCRIBED_KEYS = 4;
const MAX_DESCRIBED_ENUM = 4;

function describe(root: JSONSchema, schema: JSONSchema, depth: number): string {
  const s = deref(root, schema);
  if (isAnySchema(s) || depth > 8) return "any";
  const members = unionMembers(root, s);
  if (members) {
    if (members.length === 0) return "null";
    const parts = [...new Set(members.map((m) => describe(root, m, depth + 1)))];
    return parts.includes("any") ? "any" : parts.join(" | ");
  }
  if (Array.isArray(s.allOf) && s.allOf.length > 0) {
    return describe(root, asSchema(s.allOf[0]), depth + 1);
  }
  const values = enumValues(s);
  if (values && values.length > 0 && values.length <= MAX_DESCRIBED_ENUM) {
    return values.map((v) => JSON.stringify(v)).join(" | ");
  }
  const kinds = kindsOf(s);
  if (!kinds || kinds.size === 0) return kinds?.size === 0 ? "null" : "any";
  const parts = [...kinds].map((k) => {
    switch (k) {
      case "integer":
      case "number":
        return "number";
      case "string":
        return s.format === "date-time" ? "date" : "string";
      case "array": {
        if (s.items === undefined) return "any[]";
        const item = describe(root, asSchema(s.items), depth + 1);
        return item.includes(" ") && !item.startsWith("{") ? `(${item})[]` : `${item}[]`;
      }
      case "object": {
        const props = s.properties as Record<string, unknown> | undefined;
        const keys = props ? Object.keys(props) : [];
        if (keys.length > 0) {
          const shown = keys.slice(0, MAX_DESCRIBED_KEYS);
          if (keys.length > MAX_DESCRIBED_KEYS) shown.push("…");
          return `{ ${shown.join(", ")} }`;
        }
        const extra = s.additionalProperties;
        if (extra !== undefined && typeof extra === "object" && !isAnySchema(extra)) {
          return `Record<string, ${describe(root, asSchema(extra), depth + 1)}>`;
        }
        return extra === false ? "{}" : "object";
      }
      default:
        return k;
    }
  });
  return [...new Set(parts)].join(" | ");
}

/**
 * A short, user-facing description of a schema's type, for the data picker and messages:
 * `"string"`, `"number[]"`, `"{ id, email }"`, `"date"` (date-time strings), `"a" | "b"` (small
 * enums), `Record<string, number>`, or `"any"`. Nullability is not shown.
 */
export function describeType(schema: JSONSchema): string {
  return describe(schema, schema, 0);
}

/** Reads a literal (non-ref) value at a dot path inside config, or `undefined`. */
export function configValueAt(config: Record<string, ValueExpr>, path: string): unknown {
  let cur: unknown = config;
  for (const key of path.split(".")) {
    if (typeof cur !== "object" || cur === null || isRef(cur) || isTpl(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const FIELD_TYPES = new Set<string>(Object.keys(FIELD_TYPE_SCHEMA));

/**
 * @internal Parses a config value as a literal {@link FieldDecl} list, dropping malformed
 * entries; `undefined` when the value isn't a literal array.
 */
export function fieldDeclsAt(
  config: Record<string, ValueExpr>,
  path: string,
): FieldDecl[] | undefined {
  const value = configValueAt(config, path);
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (f): f is FieldDecl =>
      typeof f === "object" &&
      f !== null &&
      typeof (f as FieldDecl).name === "string" &&
      (f as FieldDecl).name !== "" &&
      FIELD_TYPES.has((f as FieldDecl).type),
  );
}

/** A webhook payload: the body is closed when fields are declared, any JSON when none are. */
function webhookSchema(fields: FieldDecl[] | undefined): JSONSchema {
  return {
    type: "object",
    properties: {
      body: fields && fields.length > 0 ? fieldsToJsonSchema(fields, { closed: true }) : {},
      headers: { type: "object", additionalProperties: { type: "string" } },
    },
    required: ["body", "headers"],
    additionalProperties: false,
  };
}

/**
 * The JSON Schema of a step's output, as seen by downstream references. Resolves dynamic outputs:
 * `fields` from the step's literal field declarations, `subflow` from `ctx.subflows` keyed by the
 * literal workflow ID in config. Anything not statically known is `{}` (any).
 */
export function outputSchemaFor(
  m: NodeManifest,
  step: Step,
  ctx: ValidationContext = {},
): JSONSchema {
  const spec = m.output;
  switch (spec.kind) {
    case "schema":
      return spec.schema;
    case "fields": {
      const decls = fieldDeclsAt(step.config, spec.configPath);
      return decls ? fieldsToJsonSchema(decls) : {};
    }
    case "subflow": {
      const id = configValueAt(step.config, spec.configPath);
      if (typeof id !== "string") return {};
      const sub = ctx.subflows && Object.hasOwn(ctx.subflows, id) ? ctx.subflows[id] : undefined;
      return sub?.output ?? {};
    }
    case "webhook":
      return webhookSchema(fieldDeclsAt(step.config, spec.configPath));
    default:
      return {};
  }
}

/**
 * The JSON Schema of a trigger's payload (the `trigger` scope entry). `fields` payloads are built
 * from the trigger config's literal field declarations and are closed: a reference to an
 * undeclared field doesn't resolve. `webhook` payloads are
 * `{ body: <fields>, headers: Record<string, string> }`, with a closed body when at least one
 * field is declared and any JSON when none is. Unknown shapes are `{}` (any).
 */
export function payloadSchemaFor(t: TriggerManifest, trigger: TriggerConfig): JSONSchema {
  const spec = t.payload;
  switch (spec.kind) {
    case "schema":
      return spec.schema;
    case "fields": {
      const decls = fieldDeclsAt(trigger.config, spec.configPath);
      return decls ? fieldsToJsonSchema(decls, { closed: true }) : {};
    }
    case "webhook":
      return webhookSchema(fieldDeclsAt(trigger.config, spec.configPath));
    default:
      return {};
  }
}

/** Config path of a sub-flow trigger's output field declarations (see `TriggerKind`). */
const SUBFLOW_OUTPUT_PATH = "output";

/**
 * The output fields a sub-flow declares: the literal {@link FieldDecl} list at trigger config
 * `"output"` when `t` is a `subflow` trigger, else `undefined`. The workflow's `output` mapping
 * must provide these (the engine checks them when a sub-flow run finishes).
 *
 * @example
 * subflowOutputFields(manifest.triggers.find((t) => t.type === doc.trigger.type), doc.trigger);
 * // [{ name: "found", type: "boolean", required: true }]
 */
export function subflowOutputFields(
  t: TriggerManifest | undefined,
  trigger: TriggerConfig,
): FieldDecl[] | undefined {
  if (t?.kind !== "subflow") return undefined;
  return fieldDeclsAt(trigger.config, SUBFLOW_OUTPUT_PATH);
}

/**
 * The declared output of a sub-flow: for a trigger of kind `subflow`, the closed schema of the
 * {@link FieldDecl} list at config path `"output"` (the contract of every sub-flow trigger).
 * `undefined` for other triggers, or when `output` isn't a literal list.
 */
export function subflowOutputSchema(
  t: TriggerManifest,
  trigger: TriggerConfig,
): JSONSchema | undefined {
  if (t.kind !== "subflow") return undefined;
  const decls = fieldDeclsAt(trigger.config, "output");
  return decls ? fieldsToJsonSchema(decls, { closed: true }) : undefined;
}

/**
 * The branches a step declares, in display order: none, a static list, items of a config array
 * (`fromConfig`, entries without a string ID are skipped; label falls back to the ID) followed by
 * the appended fixed branches, or `body` for loops.
 */
export function branchesFor(m: NodeManifest, step: Step): { id: string; label: string }[] {
  const spec = m.branches;
  switch (spec.kind) {
    case "static":
      return spec.branches.map((b) => ({ id: b.id, label: b.label }));
    case "fromConfig": {
      const items = configValueAt(step.config, spec.configPath);
      const out: { id: string; label: string }[] = [];
      if (Array.isArray(items)) {
        for (const item of items) {
          if (typeof item !== "object" || item === null) continue;
          const id = (item as Record<string, unknown>)[spec.idKey];
          if (typeof id !== "string" || id === "") continue;
          const label = (item as Record<string, unknown>)[spec.labelKey];
          out.push({ id, label: typeof label === "string" && label !== "" ? label : id });
        }
      }
      return [...out, ...spec.append.map((b) => ({ id: b.id, label: b.label }))];
    }
    case "loop":
      return [{ id: spec.branch, label: "Body" }];
    default:
      return [];
  }
}

/** A property's constant value (`const`, or a one-value `enum`), if it has one. */
function constOf(root: JSONSchema, prop: unknown): { value: unknown } | undefined {
  if (typeof prop !== "object" || prop === null) return undefined;
  const s = deref(root, prop as JSONSchema);
  if ("const" in s) return { value: s.const };
  if (Array.isArray(s.enum) && s.enum.length === 1) return { value: s.enum[0] };
  return undefined;
}

/** The object members of a union with their properties; members that can't hold one drop out. */
function objectMembers(
  root: JSONSchema,
  members: readonly JSONSchema[],
): { m: JSONSchema; props: Record<string, unknown> }[] {
  const out: { m: JSONSchema; props: Record<string, unknown> }[] = [];
  for (const m of members) {
    const props = deref(root, m).properties;
    if (typeof props === "object" && props !== null) {
      out.push({ m, props: props as Record<string, unknown> });
    }
  }
  return out;
}

/** The constants of `key` in every member, when each has one and they are all distinct. */
function distinctConsts(
  root: JSONSchema,
  objects: { props: Record<string, unknown> }[],
  key: string,
): string[] | undefined {
  const consts = objects.map((x) => constOf(root, x.props[key]));
  if (consts.some((c) => c === undefined)) return undefined;
  const values = consts.map((c) => JSON.stringify(c?.value));
  return new Set(values).size === values.length ? values : undefined;
}

/**
 * @internal For a union of objects told apart by a property holding a distinct constant in every
 * member (e.g. `type`), the member whose constant equals the value's; otherwise `undefined`.
 * Shared by the validator and `dropHiddenFields`, so both pick the same variant.
 */
export function discriminatedMember(
  root: JSONSchema,
  members: readonly JSONSchema[],
  value: unknown,
): JSONSchema | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  // Members that can't hold an object (e.g. the `null` of a nullable union) take no part.
  const objects = objectMembers(root, members);
  const first = objects[0];
  if (!first || objects.length < 2) return undefined;
  for (const key of Object.keys(first.props)) {
    if (!(key in obj)) continue;
    const values = distinctConsts(root, objects, key);
    if (!values) continue;
    const i = values.indexOf(JSON.stringify(obj[key]));
    return i >= 0 ? objects[i]?.m : undefined;
  }
  return undefined;
}

/**
 * @internal Whether some property tells the union's object members apart (a distinct constant in
 * each), so {@link discriminatedMember} can pick a member for any value that sets it.
 */
export function isDiscriminatedUnion(root: JSONSchema, members: readonly JSONSchema[]): boolean {
  const objects = objectMembers(root, members);
  const first = objects[0];
  if (!first || objects.length < 2) return false;
  return Object.keys(first.props).some((key) => distinctConsts(root, objects, key) !== undefined);
}

/** @internal Shared with the validator: dereference against a root. */
export { deref as derefSchema, typeList as schemaTypes, unionMembers as schemaUnionMembers };
