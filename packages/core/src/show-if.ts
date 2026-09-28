/**
 * Conditional fields ({@link UiMeta.showIf}): which properties of an object apply, shared by the
 * editor, the validator and the engine so their verdicts can't drift, plus the definition-time
 * checks the registry runs.
 *
 * @module
 */
import { asSchema, derefSchema } from "./json-schema";
import { isRef, isTpl } from "./refs";
import type { JSONSchema, Literal, ShowIf, UiMeta } from "./types";

const UI_META_KEY = "x-flowkit";

const asList = (v: Literal | Literal[]): Literal[] => (Array.isArray(v) ? v : [v]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const propertiesOf = (s: JSONSchema): Record<string, unknown> =>
  isObject(s.properties) ? s.properties : {};

/**
 * Whether a field with {@link UiMeta.showIf} `cond` applies, given its object's `values` and the
 * object schema's `properties` (for the sibling's `default`). No condition: `true`. This reads the
 * sibling's value only; {@link hiddenFields} also accounts for siblings that are hidden themselves.
 *
 * @example
 * isFieldShown({ field: "bodyType", notEquals: "none" }, { bodyType: "json" }); // true
 */
export function isFieldShown(
  cond: ShowIf | undefined,
  values: Record<string, unknown> | undefined,
  properties?: Record<string, unknown>,
): boolean {
  if (!isValidCond(cond)) return true;
  let value = values?.[cond.field];
  if (value === undefined) {
    const prop = properties?.[cond.field];
    if (isObject(prop)) value = prop.default;
  }
  if (isRef(value) || isTpl(value)) return true;
  if (cond.equals !== undefined) return asList(cond.equals).some((v) => v === value);
  if (cond.notEquals !== undefined) return !asList(cond.notEquals).some((v) => v === value);
  return value !== undefined && value !== null && value !== "" && value !== false;
}

function isValidCond(cond: unknown): cond is ShowIf {
  return isObject(cond) && typeof cond.field === "string";
}

function metaOf(s: JSONSchema): UiMeta | undefined {
  const meta = s[UI_META_KEY];
  return isObject(meta) ? (meta as UiMeta) : undefined;
}

/**
 * The {@link UiMeta.showIf} of a property schema. `$ref`s are followed against `root`, and a
 * nullable `anyOf [T, null]` also finds the condition on `T`. The editor, validator and engine all
 * read it here.
 */
export function showIfOf(schema: unknown, root: JSONSchema = {}): ShowIf | undefined {
  const s = derefSchema(root, asSchema(schema));
  const own = metaOf(s)?.showIf;
  if (isValidCond(own)) return own;
  const members = Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : undefined;
  if (members?.length !== 2) return undefined;
  const resolved = members.map((m) => derefSchema(root, asSchema(m)));
  if (!resolved.some((m) => m.type === "null")) return undefined;
  const inner = resolved.find((m) => m.type !== "null");
  const innerCond = inner ? metaOf(inner)?.showIf : undefined;
  return isValidCond(innerCond) ? innerCond : undefined;
}

/**
 * The properties of `objectSchema` that don't apply to `values` because their
 * {@link UiMeta.showIf} fails. Conditions are resolved in dependency order: a field whose
 * sibling is hidden sees that sibling as unset (without its default), so a chain A → B → C hides
 * C when B is hidden. Cycles (rejected by the registry) never hide a field.
 *
 * @param root - Schema that `$ref`s resolve against. Defaults to `objectSchema`.
 */
export function hiddenFields(
  values: Record<string, unknown> | undefined,
  objectSchema: JSONSchema,
  root: JSONSchema = objectSchema,
): Set<string> {
  const props = propertiesOf(derefSchema(root, objectSchema));
  const shown = new Map<string, boolean>();
  const visiting = new Set<string>();
  const isShown = (key: string): boolean => {
    const known = shown.get(key);
    if (known !== undefined) return known;
    const cond = showIfOf(props[key], root);
    if (!cond || visiting.has(key)) return true;
    visiting.add(key);
    const siblingShown = Object.hasOwn(props, cond.field) ? isShown(cond.field) : true;
    visiting.delete(key);
    const result = siblingShown
      ? isFieldShown(cond, values, props)
      : isFieldShown(cond, undefined, undefined);
    shown.set(key, result);
    return result;
  };
  const hidden = new Set<string>();
  for (const key of Object.keys(props)) if (!isShown(key)) hidden.add(key);
  return hidden;
}

/** `schema` without a nullable wrapper: `anyOf [T, null]` → `T`. */
function nonNull(root: JSONSchema, schema: JSONSchema): JSONSchema {
  const s = derefSchema(root, schema);
  const members = Array.isArray(s.anyOf) ? s.anyOf : undefined;
  if (members?.length !== 2) return s;
  const resolved = members.map((m) => derefSchema(root, asSchema(m)));
  if (!resolved.some((m) => m.type === "null")) return s;
  return resolved.find((m) => m.type !== "null") ?? s;
}

/**
 * `value` with the values of hidden fields ({@link hiddenFields}) removed, at every level of
 * objects and arrays that `schema` describes. The engine applies this to a step's resolved
 * config before parsing its input, so handlers never see a hidden field. The argument is not
 * modified.
 *
 * @param root - Schema that `$ref`s resolve against. Defaults to `schema`.
 */
export function dropHiddenFields(
  value: unknown,
  schema: JSONSchema,
  root: JSONSchema = schema,
): unknown {
  const s = nonNull(root, schema);
  if (Array.isArray(value)) {
    const items = s.items;
    return isObject(items) ? value.map((v) => dropHiddenFields(v, items, root)) : value;
  }
  if (!isObject(value)) return value;
  const props = propertiesOf(s);
  if (Object.keys(props).length === 0) return value;
  const hidden = hiddenFields(value, s, root);
  const out: [string, unknown][] = [];
  for (const [k, v] of Object.entries(value)) {
    if (hidden.has(k)) continue;
    const prop = props[k];
    out.push([k, isObject(prop) ? dropHiddenFields(v, prop, root) : v]);
  }
  return Object.fromEntries(out);
}

/**
 * Definition errors in the {@link UiMeta.showIf} conditions anywhere in `schema`: a condition
 * whose `field` isn't a sibling property, a conditional field that is required (it must be
 * optional, since a hidden field has no value), and conditions that form a cycle. Empty when
 * all are sound.
 */
export function showIfProblems(schema: JSONSchema): string[] {
  const problems: string[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, path);
      return;
    }
    if (!isObject(node) || seen.has(node)) return;
    seen.add(node);
    const s = node as JSONSchema;
    const props = propertiesOf(s);
    const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    const edges = new Map<string, string>();
    const at = (key: string) => (path === "" ? key : `${path}.${key}`);
    for (const [key, prop] of Object.entries(props)) {
      const cond = showIfOf(prop, schema);
      if (!cond) continue;
      if (!Object.hasOwn(props, cond.field) || cond.field === key) {
        problems.push(`"${at(key)}" has showIf on "${cond.field}", which isn't a sibling field`);
        continue;
      }
      if (required.has(key)) {
        problems.push(`"${at(key)}" has showIf but is required; make it optional`);
      }
      edges.set(key, cond.field);
    }
    const reported = new Set<string>();
    for (const start of edges.keys()) {
      const chain = [start];
      let next = edges.get(start);
      while (next !== undefined && !chain.includes(next)) {
        chain.push(next);
        next = edges.get(next);
      }
      if (next !== start || reported.has(start)) continue;
      for (const k of chain) reported.add(k);
      problems.push(`showIf conditions form a cycle: ${[...chain, start].map(at).join(" → ")}`);
    }
    for (const [key, prop] of Object.entries(props)) visit(prop, at(key));
    for (const k of ["items", "prefixItems", "additionalProperties", "anyOf", "oneOf", "allOf"]) {
      visit(s[k], k === "items" || k === "prefixItems" ? `${path}[]` : path);
    }
    for (const k of ["$defs", "definitions"]) {
      if (isObject(s[k])) for (const def of Object.values(s[k])) visit(def, path);
    }
  };
  visit(schema, "");
  return problems;
}
