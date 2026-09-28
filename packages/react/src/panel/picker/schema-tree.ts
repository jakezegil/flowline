/**
 * The data picker's model: a lazily expanded tree of the values in scope, built from each
 * {@link ScopeEntry}'s schema and filled in from sample data where the schema is open.
 *
 * @module
 */

import {
  describeType,
  formatRefPath,
  isAnySchema,
  isAssignable,
  type JSONSchema,
  parseRefPath,
  type RefPath,
  type ScopeEntry,
  schemaAtPath,
} from "@flowkit/core";

/** Sample key standing for the trigger (the editor store's `TRIGGER_KEY`). */
const TRIGGER_SAMPLE_KEY = "__trigger";

/** Deepest level the search and autocomplete walk (sections are depth 0). */
export const MAX_SEARCH_DEPTH = 5;
/**
 * Most nodes the search and autocomplete walk collects per section. A budget per section (not
 * one for the whole scope) means every step is searched however many come before it; it only
 * bounds pathological schemas (deep, wide, self-similar).
 */
const MAX_SECTION_NODES = 5000;

/** One row of the tree: a scope entry (depth 0) or a value inside one. */
export interface PickerNode {
  /** Unique within a tree: the ref path. */
  id: string;
  /** The `$ref` path this row inserts. */
  ref: string;
  /** The row's name: the section label, a property key or "[0]". */
  name: string;
  /** Path below the section, for search and autocomplete: `"email"`, `"items[0].sku"`. */
  pathLabel: string;
  schema: JSONSchema;
  /** Short type, e.g. `string`, `number[]`, `object`. */
  typeLabel: string;
  /** Sample value at this path, when a sample exists and has the path. */
  sample?: { value: unknown };
  depth: number;
  /** True if the row has children to expand into. */
  expandable: boolean;
  entry: ScopeEntry;
  /** Set on the `[0]` row of a list. */
  firstItem?: boolean;
  /** False for rows that aren't a value of their own (the loop section: pick `item` or `index`). */
  insertable: boolean;
}

/** Scope in picker order: the loop first, then the trigger, then steps nearest-first. */
export function orderScope(scope: readonly ScopeEntry[]): ScopeEntry[] {
  const loop = scope.filter((e) => e.kind === "loop");
  const trigger = scope.filter((e) => e.kind === "trigger");
  const steps = scope.filter((e) => e.kind === "step").reverse();
  return [...loop, ...trigger, ...steps];
}

function sampleRoot(
  entry: ScopeEntry,
  samples: Record<string, unknown>,
): { value: unknown } | undefined {
  const key =
    entry.kind === "trigger"
      ? TRIGGER_SAMPLE_KEY
      : entry.kind === "step"
        ? entry.stepId
        : undefined;
  if (key === undefined || !Object.hasOwn(samples, key)) return undefined;
  return { value: samples[key] };
}

function sampleAt(root: { value: unknown } | undefined, segments: readonly (string | number)[]) {
  if (!root) return undefined;
  let cur: unknown = root.value;
  for (const seg of segments) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (!Object.hasOwn(cur, seg)) return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return { value: cur };
}

/** A schema describing a sample value, for rows the entry's schema doesn't declare. */
export function inferSchema(value: unknown): JSONSchema {
  if (value === null) return { type: "null" };
  if (Array.isArray(value))
    return { type: "array", items: value.length ? inferSchema(value[0]) : {} };
  switch (typeof value) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "object": {
      const properties: Record<string, JSONSchema> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        properties[k] = inferSchema(v);
      }
      return { type: "object", properties };
    }
    default:
      return {};
  }
}

/** The shape of a schema as far as the tree cares: declared keys, list items, openness. */
interface Shape {
  keys: string[];
  /** Whether a numeric index can be taken (it's a list). */
  list: boolean;
  /** Whether undeclared keys may exist (any, records, open objects). */
  open: boolean;
}

function deref(root: JSONSchema, schema: JSONSchema, depth = 0): JSONSchema {
  const ref = schema.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#") || depth > 16) return schema;
  let target: unknown = root;
  for (const token of ref.slice(1).split("/").slice(1)) {
    if (typeof target !== "object" || target === null) return {};
    target = (target as Record<string, unknown>)[token.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  if (typeof target !== "object" || target === null) return {};
  return deref(root, target as JSONSchema, depth + 1);
}

function types(schema: JSONSchema): string[] | undefined {
  const t = schema.type;
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return undefined;
}

function shapeOf(root: JSONSchema, raw: JSONSchema, depth = 0): Shape {
  const schema = deref(root, raw);
  if (isAnySchema(schema)) return { keys: [], list: false, open: true };
  const shape: Shape = { keys: [], list: false, open: false };
  const merge = (s: Shape) => {
    for (const k of s.keys) if (!shape.keys.includes(k)) shape.keys.push(k);
    shape.list ||= s.list;
    shape.open ||= s.open;
  };
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const members = schema[key];
    if (Array.isArray(members) && depth < 8) {
      for (const m of members) {
        if (typeof m === "object" && m !== null) merge(shapeOf(root, m as JSONSchema, depth + 1));
      }
    }
  }
  const t = types(schema);
  const props = schema.properties as Record<string, unknown> | undefined;
  if (props && typeof props === "object")
    merge({ keys: Object.keys(props), list: false, open: false });
  if (t?.includes("array") || schema.items !== undefined || schema.prefixItems !== undefined) {
    shape.list = true;
  }
  if (t?.includes("object") || props) {
    const extra = schema.additionalProperties;
    if (!props || (extra !== undefined && extra !== false)) shape.open = true;
  }
  return shape;
}

/** Short type label: `{ id, email }` → `object`, `{ … }[]` → `object[]`, `"a" | "b"` → `enum`. */
export function shortType(schema: JSONSchema): string {
  const full = describeType(schema);
  if (/^"[^"]*"( \| "[^"]*")+$/.test(full)) return "enum";
  return full.replace(/\{[^{}]*\}/g, "object").replace(/Record<string, [^>]*>/g, "object");
}

function makeNode(
  entry: ScopeEntry,
  segments: (string | number)[],
  name: string,
  schema: JSONSchema,
  sample: { value: unknown } | undefined,
  depth: number,
  firstItem = false,
): PickerNode {
  const ref = formatRefPath(refPathOf(entry, segments));
  const effective =
    isAnySchema(schema) && sample && sample.value !== undefined
      ? inferSchema(sample.value)
      : schema;
  const shape = shapeOf(effective, effective);
  const sampleKids =
    sample &&
    sample.value !== null &&
    typeof sample.value === "object" &&
    Object.keys(sample.value).length > 0;
  return {
    id: ref,
    ref,
    name,
    pathLabel: pathText(segments),
    schema: effective,
    typeLabel: shortType(effective),
    ...(sample ? { sample } : {}),
    depth,
    expandable: shape.keys.length > 0 || shape.list || Boolean(shape.open && sampleKids),
    entry,
    ...(firstItem ? { firstItem: true } : {}),
    insertable: !(entry.kind === "loop" && segments.length === 0),
  };
}

/** The ref path of `segments` below an entry (`loop` alone isn't a valid ref, so no parsing). */
function refPathOf(entry: ScopeEntry, segments: (string | number)[]): RefPath {
  if (entry.kind === "loop") return { root: "loop", segments };
  const base = parseRefPath(entry.refBase);
  return { ...base, segments: [...base.segments, ...segments] };
}

/** `["items", 0, "sku"]` → `items[0].sku`. */
export function pathText(segments: readonly (string | number)[]): string {
  let out = "";
  for (const seg of segments) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out ? `.${seg}` : seg;
  }
  return out;
}

/** Segments of `node` below its section. */
function segmentsOf(node: PickerNode): (string | number)[] {
  if (node.depth === 0) return [];
  const path = parseRefPath(node.ref);
  return node.entry.kind === "loop"
    ? path.segments
    : path.segments.slice(parseRefPath(node.entry.refBase).segments.length);
}

/** The top-level rows: one per scope entry, in picker order. */
export function sectionNodes(
  scope: readonly ScopeEntry[],
  samples: Record<string, unknown>,
): PickerNode[] {
  return orderScope(scope).map((entry) => {
    const node = makeNode(entry, [], entry.label, entry.schema, sampleRoot(entry, samples), 0);
    return { ...node, id: `section:${entry.refBase}:${entry.stepId ?? ""}`, expandable: true };
  });
}

/** The children of a row: declared properties (then sample-only keys), or a list's `[0]`. */
export function childNodes(node: PickerNode, samples: Record<string, unknown>): PickerNode[] {
  const segments = segmentsOf(node);
  const root = sampleRoot(node.entry, samples);
  const shape = shapeOf(node.schema, node.schema);
  const out: PickerNode[] = [];
  const sample = node.sample?.value;
  const childSchema = (seg: string | number): JSONSchema => {
    const declared = schemaAtPath(node.entry.schema, [...segments, seg]);
    if (declared !== undefined && !isAnySchema(declared)) return declared;
    // The row's own (possibly sample-inferred) schema knows more than the entry's.
    return schemaAtPath(node.schema, [seg]) ?? {};
  };
  if (shape.list || Array.isArray(sample)) {
    out.push(
      makeNode(
        node.entry,
        [...segments, 0],
        "[0]",
        childSchema(0),
        sampleAt(root, [...segments, 0]),
        node.depth + 1,
        true,
      ),
    );
    return out;
  }
  const keys = [...shape.keys];
  if (sample !== null && typeof sample === "object" && !Array.isArray(sample)) {
    for (const k of Object.keys(sample)) if (!keys.includes(k)) keys.push(k);
  }
  for (const key of keys) {
    out.push(
      makeNode(
        node.entry,
        [...segments, key],
        key,
        childSchema(key),
        sampleAt(root, [...segments, key]),
        node.depth + 1,
      ),
    );
  }
  return out;
}

/** Any single value that isn't a list or an object: what a text, number or yes/no field takes. */
export const SCALAR_FILTER: JSONSchema = {
  type: ["string", "number", "integer", "boolean", "null"],
};

/**
 * The picker filter for a field of schema `schema`: {@link SCALAR_FILTER} for text, number,
 * boolean and enum fields (so a list or object can't be dropped into them), the schema itself for
 * list and object fields, and none for any-typed (JSON) fields or without a schema.
 */
export function pickFilterFor(schema: JSONSchema | undefined): JSONSchema | undefined {
  if (!schema || isAnySchema(schema)) return undefined;
  return isAssignable(schema, SCALAR_FILTER) ? SCALAR_FILTER : schema;
}

/** The kind of a sample value, as a schema, or `undefined` without one. */
function sampleSchema(node: PickerNode): JSONSchema | undefined {
  if (!node.sample) return undefined;
  const v = node.sample.value;
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) return { type: "array" };
  switch (typeof v) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "object":
      return { type: "object" };
    default:
      return undefined;
  }
}

/**
 * True if a row's value can go into a field of type `filterType` (always, without a filter). An
 * any-typed row is judged by its sample value when it has one (a text `paths[0]` doesn't fit a
 * list), and fits otherwise.
 */
export function fitsFilter(node: PickerNode, filterType: JSONSchema | undefined): boolean {
  if (!filterType || isAnySchema(filterType)) return true;
  if (isAnySchema(node.schema)) {
    const seen = sampleSchema(node);
    return seen ? isAssignable(seen, filterType) : true;
  }
  return isAssignable(node.schema, filterType);
}

/**
 * Every row of every section down to {@link MAX_SEARCH_DEPTH}, depth-first in picker order, for
 * search and autocomplete. Callers walk it once per scope and reuse it across keystrokes.
 */
export function flattenTree(
  scope: readonly ScopeEntry[],
  samples: Record<string, unknown>,
): PickerNode[] {
  const out: PickerNode[] = [];
  let budget = 0;
  const visit = (node: PickerNode) => {
    if (budget-- <= 0) return;
    out.push(node);
    if (node.expandable && node.depth < MAX_SEARCH_DEPTH) {
      for (const child of childNodes(node, samples)) visit(child);
    }
  };
  for (const section of sectionNodes(scope, samples)) {
    budget = MAX_SECTION_NODES;
    visit(section);
  }
  return out;
}

/** A sample value as one short line: strings bare, lists as "3 items", objects as "{…}". */
export function formatSample(
  value: unknown,
  labels: { items(n: number): string; keys(n: number): string },
  max = 48,
): string {
  let text: string;
  if (value === undefined) text = "";
  else if (typeof value === "string") text = value;
  else if (Array.isArray(value)) text = labels.items(value.length);
  else if (value !== null && typeof value === "object")
    text = labels.keys(Object.keys(value).length);
  else text = String(value);
  text = text.replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
