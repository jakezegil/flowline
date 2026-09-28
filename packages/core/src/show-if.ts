/**
 * Conditional fields ({@link UiMeta.showIf}): which properties of an object apply, shared by the
 * editor, the validator and the engine so their verdicts can't drift, plus the definition-time
 * checks the registry runs.
 *
 * @module
 */
import {
  asSchema,
  containsSecret,
  derefSchema,
  discriminatedMember,
  isDiscriminatedUnion,
} from "./json-schema";
import { isRef, isTpl } from "./refs";
import type { JSONSchema, Literal, ShowIf, UiMeta } from "./types";

const UI_META_KEY = "x-flowline";

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

/** The members of a union schema (`anyOf` / `oneOf`), if it is one. */
function unionMembers(s: JSONSchema): JSONSchema[] | undefined {
  const members = Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : undefined;
  return members?.map(asSchema);
}

/** Whether `members` are a nullable wrapper: exactly `[T, null]`. */
function isNullablePair(root: JSONSchema, members: JSONSchema[]): boolean {
  return members.length === 2 && members.some((m) => derefSchema(root, m).type === "null");
}

/** `schema` without a nullable wrapper: `anyOf [T, null]` → `T`. */
function nonNull(root: JSONSchema, schema: JSONSchema): JSONSchema {
  const s = derefSchema(root, schema);
  const members = unionMembers(s);
  if (!members || !isNullablePair(root, members)) return s;
  const inner = members.find((m) => derefSchema(root, m).type !== "null");
  return inner ? derefSchema(root, inner) : s;
}

/**
 * `value` with the values of hidden fields ({@link hiddenFields}) removed, at every level that
 * `schema` describes: object properties, map values (`additionalProperties`), array items,
 * nullable wrappers and discriminated unions (the member the value's discriminator names, as the
 * validator picks it). A union without a discriminator is left as is; {@link showIfProblems}
 * rejects `showIf` inside one. The engine applies this to a step's resolved config and to trigger
 * config before parsing them, so plugin code never sees a hidden field. The argument is not
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
  const members = unionMembers(s);
  if (members && !isObject(s.properties)) {
    const member = discriminatedMember(root, members, value);
    return member ? dropHiddenFields(value, member, root) : value;
  }
  const props = propertiesOf(s);
  const extra = isObject(s.additionalProperties) ? s.additionalProperties : undefined;
  if (Object.keys(props).length === 0 && !extra) return value;
  const hidden = hiddenFields(value, s, root);
  const out: [string, unknown][] = [];
  for (const [k, v] of Object.entries(value)) {
    if (hidden.has(k)) continue;
    const sub = Object.hasOwn(props, k) ? props[k] : extra;
    out.push([k, isObject(sub) ? dropHiddenFields(v, sub, root) : v]);
  }
  return Object.fromEntries(out);
}

/**
 * Definition errors in the {@link UiMeta.showIf} conditions anywhere in `schema`:
 * - a condition whose `field` isn't a sibling property;
 * - a conditional field that is required (it must be optional, since a hidden field has no
 *   value);
 * - conditions that form a cycle;
 * - a condition where {@link dropHiddenFields} can't reach it: inside a union without a
 *   discriminator, an `allOf` or a tuple (`prefixItems`);
 * - a conditional field that is, or contains, a `secret()` field.
 *
 * Empty when all are sound.
 */
export function showIfProblems(schema: JSONSchema): string[] {
  const problems: string[] = [];
  const seen = new Set<unknown>();
  const seenUnreachable = new Set<unknown>();
  const refs = new Set<string>();
  /** `unreachable`: why hidden values below here can't be dropped, if they can't. */
  const visit = (node: unknown, path: string, unreachable?: string): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, path, unreachable);
      return;
    }
    const done = unreachable ? seenUnreachable : seen;
    if (!isObject(node) || done.has(node)) return;
    done.add(node);
    const s = node as JSONSchema;
    // Follow a $ref once per reachability (recursive schemas would loop otherwise).
    if (typeof s.$ref === "string" && !refs.has(`${unreachable}|${s.$ref}`)) {
      refs.add(`${unreachable}|${s.$ref}`);
      visit(derefSchema(schema, s), path, unreachable);
    }
    const props = propertiesOf(s);
    const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    const edges = new Map<string, string>();
    const at = (key: string) => (path === "" ? key : `${path}.${key}`);
    for (const [key, prop] of Object.entries(props)) {
      const cond = showIfOf(prop, schema);
      if (!cond) continue;
      if (containsSecret(schema, asSchema(prop))) {
        // Hiding a secret would silently drop it (e.g. turn off a signature check).
        problems.push(
          `"${at(key)}" has showIf but is or contains a secret() field; secrets can't be conditional`,
        );
      }
      if (unreachable) {
        problems.push(`"${at(key)}" has showIf inside ${unreachable}, which isn't supported`);
        continue;
      }
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
    for (const [key, prop] of Object.entries(props)) visit(prop, at(key), unreachable);
    visit(s.items, `${path}[]`, unreachable);
    visit(s.additionalProperties, `${path}.*`, unreachable);
    visit(s.prefixItems, `${path}[]`, unreachable ?? "a tuple (prefixItems)");
    visit(s.allOf, path, unreachable ?? "an allOf");
    const members = unionMembers(s);
    if (members) {
      const supported = isNullablePair(schema, members) || isDiscriminatedUnion(schema, members);
      visit(
        members,
        path,
        unreachable ?? (supported ? undefined : "a union without a discriminator"),
      );
    }
    for (const k of ["$defs", "definitions"]) {
      if (isObject(s[k])) for (const def of Object.values(s[k])) visit(def, path, unreachable);
    }
  };
  visit(schema, "");
  return problems;
}
