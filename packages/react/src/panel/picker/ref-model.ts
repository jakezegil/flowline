/**
 * The value model of a reference input: a config value (literal string, `{ $ref }` or
 * `{ $tpl }`) as a list of text and reference parts, and back.
 *
 * @module
 */

import {
  isRef,
  isTpl,
  type JSONSchema,
  parseRefPath,
  parseTemplate,
  type RefPath,
  type ScopeEntry,
  schemaAtPath,
  type ValueExpr,
} from "@flowlinejs/core";
import { refLabel } from "../../canvas/summary";
import type { FlowlineLabels } from "../../labels";
import { shortType } from "./schema-tree";

/** One chunk of a reference input's content. */
export type RefPart = { text: string } | { ref: string };

/** Text of a value that isn't a string, ref or template, as the input shows it. */
function otherText(value: ValueExpr): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "";
  return JSON.stringify(value);
}

/**
 * The parts a value shows as: a literal string is one text part (its `{{` stays literal), a
 * `$ref` one pill, a `$tpl` its text and pills. With `literalOnly`, refs and templates show as
 * their raw text.
 */
export function valueToParts(value: ValueExpr | undefined, literalOnly = false): RefPart[] {
  if (value === undefined || value === "") return [];
  if (typeof value === "string") return [{ text: value }];
  if (isRef(value)) return literalOnly ? [{ text: `{{${value.$ref}}}` }] : [{ ref: value.$ref }];
  if (isTpl(value)) return literalOnly ? [{ text: value.$tpl }] : parseTemplate(value.$tpl);
  const text = otherText(value);
  return text ? [{ text }] : [];
}

/** Escapes literal `{{` in template text, so it doesn't read as a reference. */
function escapeText(text: string): string {
  return text.replace(/\{\{/g, "\\{{");
}

/**
 * The value of some parts: nothing → `undefined`; text only → a literal string; one pill and
 * nothing else → `{ $ref }`; anything else → `{ $tpl }` with literal `{{` escaped.
 */
export function partsToValue(parts: readonly RefPart[]): ValueExpr | undefined {
  const merged: RefPart[] = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if ("text" in part) {
      if (part.text === "") continue;
      if (last && "text" in last) merged[merged.length - 1] = { text: last.text + part.text };
      else merged.push(part);
    } else merged.push(part);
  }
  if (merged.length === 0) return undefined;
  const refs = merged.filter((p): p is { ref: string } => "ref" in p);
  if (refs.length === 0) return merged.map((p) => ("text" in p ? p.text : "")).join("");
  const [only] = merged;
  if (merged.length === 1 && only && "ref" in only) return { $ref: only.ref };
  return { $tpl: merged.map((p) => ("text" in p ? escapeText(p.text) : `{{${p.ref}}}`)).join("") };
}

/** A stable string key of a value, to tell a new external value from the one just emitted. */
export function valueKey(value: ValueExpr | undefined): string {
  return value === undefined ? "∅" : JSON.stringify(value);
}

/** What a pill shows about its reference. */
export interface PillInfo {
  ref: string;
  /** `Load contact › email` */
  label: string;
  /** Section label: `Load contact`. */
  head: string;
  /** Path below it: `email` (empty for a whole output). */
  path: string;
  /** Icon name of the producing trigger/step/loop. */
  icon?: string;
  /** Short type, or `any` when unknown. */
  type: string;
  /** The reference doesn't resolve in this scope (or the host flagged it). */
  stale: boolean;
}

function entryFor(path: RefPath, scope: readonly ScopeEntry[]): ScopeEntry | undefined {
  const base = path.root === "steps" ? `steps.${path.stepId}` : path.root;
  for (let i = scope.length - 1; i >= 0; i--) {
    if (scope[i]?.refBase === base) return scope[i];
  }
  return undefined;
}

/** Resolves a pill's label, icon, type and staleness against the scope. */
export function pillInfo(
  ref: string,
  scope: readonly ScopeEntry[],
  invalidRefs: ReadonlySet<string> | undefined,
  labels: FlowlineLabels,
): PillInfo {
  const stepName = (id: string) => scope.find((e) => e.kind === "step" && e.stepId === id)?.label;
  const label = refLabel(ref, stepName, labels);
  const [head = label, ...rest] = label.split(" › ");
  let path: RefPath | undefined;
  try {
    path = parseRefPath(ref);
  } catch {
    path = undefined;
  }
  let schema: JSONSchema | undefined;
  let entry: ScopeEntry | undefined;
  if (path && path.root !== "run") {
    entry = entryFor(path, scope);
    if (entry) schema = schemaAtPath(entry.schema, path.segments);
  } else if (path) {
    schema = { type: "string" };
  }
  const unresolved = !path || (path.root !== "run" && schema === undefined);
  return {
    ref,
    label,
    head,
    path: rest.join(" › "),
    ...(entry?.icon !== undefined ? { icon: entry.icon } : {}),
    type: schema ? shortType(schema) : "any",
    stale: invalidRefs?.has(ref) === true || (scope.length > 0 && unresolved),
  };
}

/** `{{ path }}` occurrences in pasted text that are valid references, as `[from, to, ref]`. */
export function findRefs(text: string): [number, number, string][] {
  const out: [number, number, string][] = [];
  const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const ref = m[1] as string;
    try {
      parseRefPath(ref);
    } catch {
      continue;
    }
    if (m.index > 0 && text.charAt(m.index - 1) === "\\") continue;
    out.push([m.index, m.index + m[0].length, ref]);
  }
  return out;
}
