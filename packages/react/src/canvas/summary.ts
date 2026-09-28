/**
 * Renders a node's `summary` template (e.g. `"Load {{contactId}}"`) against a step's config for
 * its card: `{{key}}` is a config path; literal values render as text (choices by their option
 * label), references as pills labelled like `Trigger › contactId` or `Load contact › email`.
 * `{{#key}}…{{/key}}` is an optional section, rendered only while `key` is set and shown
 * (e.g. `"{{strategy}}{{#team}} · {{team}}{{/team}}"`).
 *
 * @module
 */

import {
  configValueAt,
  hiddenFields,
  isRef,
  isTpl,
  type JSONSchema,
  parseRefPath,
  parseTemplate,
  type RefPath,
  type Step,
  type ValueExpr,
} from "@flowkit/core";
import { defaultLabels, type FlowkitLabels } from "../labels";
import { metaOf, optionLabel } from "../panel/schema";

/** An optional section of a summary: `{{#key}}…{{/key}}`. */
const SECTION = /\{\{#\s*([\w.]+)\s*\}\}([\s\S]*?)\{\{\/\s*\1\s*\}\}/g;

/**
 * `summary` with its optional sections resolved against `config`: kept (without the markers)
 * while their key is set and not hidden by `showIf`, else dropped.
 */
function resolveSections(
  summary: string,
  config: Record<string, ValueExpr>,
  schema: JSONSchema | undefined,
): string {
  if (!summary.includes("{{#")) return summary;
  const hidden = schema ? hiddenFields(config, schema) : new Set<string>();
  return summary.replace(SECTION, (_, key: string, body: string) => {
    const value = configValueAt(config, key);
    return isUnset(value) || hidden.has(key.split(".")[0] as string) ? "" : body;
  });
}

/** A chunk of a rendered summary. */
export type SummaryPart =
  | { kind: "text"; text: string }
  | { kind: "ref"; label: string; ref: string }
  /** An unset value's schema default, shown muted. */
  | { kind: "default"; text: string }
  /** A config value that is not set and has no default, e.g. "No subject" (shown muted). */
  | { kind: "empty"; label: string };

/** A rendered summary. `blank`: every value the template reads is unset, with no default. */
export interface RenderedSummary {
  parts: SummaryPart[];
  blank: boolean;
}

/** Longest literal shown before truncating with an ellipsis. */
const MAX_LITERAL = 48;

function truncate(text: string): string {
  return text.length > MAX_LITERAL ? `${text.slice(0, MAX_LITERAL - 1)}…` : text;
}

function pathLabel(segments: (string | number)[]): string {
  return segments.map((s) => (typeof s === "number" ? `[${s}]` : s)).join(".");
}

/**
 * Pill label of a ref path. `stepName` gives the display name of a step ID (or `undefined`
 * when there is no such step, in which case the ID is shown).
 */
export function refLabel(
  ref: string,
  stepName: (id: string) => string | undefined,
  labels: FlowkitLabels = defaultLabels,
): string {
  let path: RefPath;
  try {
    path = parseRefPath(ref);
  } catch {
    return ref;
  }
  const rest = pathLabel(path.segments);
  const join = (head: string, tail: string) => (tail ? `${head} › ${tail}` : head);
  switch (path.root) {
    case "trigger":
      return join(labels.refTrigger, rest);
    case "steps": {
      const id = path.stepId as string;
      return join(stepName(id) ?? id, rest);
    }
    case "loop":
      return path.segments[0] === "index"
        ? labels.refLoopIndex
        : join(labels.refItem, pathLabel(path.segments.slice(1)));
    case "run":
      return labels.refRunId;
    default:
      return ref;
  }
}

/** The step IDs referenced by the values the summary template of `step` reads. */
export function summaryStepRefs(summary: string | undefined, step: Step): string[] {
  if (!summary) return [];
  const template = resolveSections(summary, step.config, undefined);
  const ids = new Set<string>();
  const visit = (ref: string) => {
    try {
      const p = parseRefPath(ref);
      if (p.root === "steps" && p.stepId) ids.add(p.stepId);
    } catch {
      // Invalid refs are labelled verbatim.
    }
  };
  // References anywhere in the value (a rule group's comparisons hold them too).
  const walk = (value: unknown): void => {
    if (isRef(value)) visit(value.$ref);
    else if (isTpl(value)) {
      for (const p of parseTemplate(value.$tpl)) if ("ref" in p) visit(p.ref);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(walk);
  };
  for (const part of parseTemplate(template)) {
    if ("ref" in part) walk(configValueAt(step.config, part.ref));
  }
  return [...ids];
}

/** The schema of the config field at dot path `path` of an object schema. */
function fieldSchema(schema: JSONSchema | undefined, path: string): JSONSchema | undefined {
  let cur: unknown = schema;
  for (const key of path.split(".")) {
    const props = (cur as { properties?: Record<string, unknown> } | undefined)?.properties;
    cur = props?.[key];
    if (typeof cur !== "object" || cur === null) return undefined;
  }
  return cur as JSONSchema;
}

/** "contactId" → "Contact id", "due_date" → "Due date". */
function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A rule group's comparisons, as the rules widget stores them. */
interface RuleLike {
  left?: unknown;
  op?: unknown;
  right?: unknown;
  rules?: unknown;
  combinator?: unknown;
}

const UNARY_OPS = new Set(["isEmpty", "isNotEmpty", "isTrue", "isFalse"]);

/** The comparisons of a rule group, nested groups flattened in order. */
function flatRules(group: RuleLike): RuleLike[] {
  if (!Array.isArray(group.rules)) return [];
  return (group.rules as RuleLike[]).flatMap((r) =>
    typeof r === "object" && r !== null && Array.isArray(r.rules) ? flatRules(r) : [r],
  );
}

/**
 * The first comparison of a `"rules"` widget value, in words ("Trigger › stage equals won"),
 * then "and 2 more" (or "or 2 more"); "no conditions" when there are none.
 */
function ruleParts(
  group: RuleLike,
  stepName: (id: string) => string | undefined,
  labels: FlowkitLabels,
): SummaryPart[] {
  const rules = flatRules(group);
  const [first] = rules;
  if (!first) return [{ kind: "empty", label: labels.noConditions }];
  const side = (v: unknown): SummaryPart[] =>
    isRef(v) || isTpl(v)
      ? valueParts(v as ValueExpr, "", undefined, stepName, labels)
      : [{ kind: "text", text: literalText(v, labels) }];
  const op = typeof first.op === "string" ? first.op : "eq";
  const parts: SummaryPart[] = [
    ...side(first.left),
    { kind: "text", text: ` ${labels.ruleOps[op] ?? op}` },
  ];
  if (!UNARY_OPS.has(op)) parts.push({ kind: "text", text: " " }, ...side(first.right));
  if (rules.length > 1) {
    parts.push({
      kind: "text",
      text: ` ${labels.moreRules(rules.length - 1, group.combinator === "or")}`,
    });
  }
  return parts;
}

/** Display text of a literal value (a choice of an enum field by its option label). */
function literalText(value: unknown, labels: FlowkitLabels, field?: JSONSchema): string {
  if (Array.isArray(value)) return labels.items(value.length);
  if (typeof value === "object" && value !== null) return "…";
  if (Array.isArray(field?.enum) && field.enum.includes(value as never))
    return truncate(optionLabel(value, metaOf(field)));
  return truncate(String(value));
}

const isUnset = (v: unknown) => v === undefined || v === null || v === "";

function unsetParts(
  path: string,
  schema: JSONSchema | undefined,
  labels: FlowkitLabels,
): SummaryPart[] {
  const field = fieldSchema(schema, path);
  const fallback = field?.default;
  if (!isUnset(fallback)) return [{ kind: "default", text: literalText(fallback, labels, field) }];
  const meta = field?.["x-flowkit"] as { label?: unknown } | undefined;
  const label =
    typeof meta?.label === "string" && meta.label
      ? meta.label
      : typeof field?.title === "string" && field.title
        ? field.title
        : humanize(path.split(".").pop() ?? path);
  return [{ kind: "empty", label: labels.noValue(label) }];
}

function valueParts(
  value: ValueExpr | undefined,
  path: string,
  schema: JSONSchema | undefined,
  stepName: (id: string) => string | undefined,
  labels: FlowkitLabels,
): SummaryPart[] {
  if (isUnset(value)) return unsetParts(path, schema, labels);
  if (isRef(value))
    return [{ kind: "ref", ref: value.$ref, label: refLabel(value.$ref, stepName, labels) }];
  if (isTpl(value)) {
    return parseTemplate(value.$tpl).map((p) =>
      "text" in p
        ? { kind: "text", text: truncate(p.text) }
        : { kind: "ref", ref: p.ref, label: refLabel(p.ref, stepName, labels) },
    );
  }
  const field = fieldSchema(schema, path);
  if (metaOf(field).widget === "rules" && typeof value === "object" && value !== null)
    return ruleParts(value as RuleLike, stepName, labels);
  return [{ kind: "text", text: literalText(value, labels, field) }];
}

/**
 * Renders `summary` against `step.config`. Adjacent text parts are merged. An unset value shows
 * its schema default (from `inputSchema`, the node's input schema) muted, or else "No <label>"
 * built from the field's `x-flowkit.label`, `title` or humanized key.
 */
export function renderSummary(
  summary: string,
  step: Step,
  stepName: (id: string) => string | undefined,
  inputSchema?: JSONSchema,
  labels: FlowkitLabels = defaultLabels,
): RenderedSummary {
  const out: SummaryPart[] = [];
  let values = 0;
  let unset = 0;
  for (const part of parseTemplate(resolveSections(summary, step.config, inputSchema))) {
    let parts: SummaryPart[];
    if ("text" in part) parts = [{ kind: "text", text: part.text }];
    else {
      values++;
      const value = configValueAt(step.config, part.ref) as ValueExpr | undefined;
      parts = valueParts(value, part.ref, inputSchema, stepName, labels);
      if (parts[0]?.kind === "empty") unset++;
    }
    for (const p of parts) {
      const last = out[out.length - 1];
      if (p.kind === "text" && last?.kind === "text") last.text += p.text;
      else out.push(p.kind === "text" ? { ...p } : p);
    }
  }
  return { parts: out, blank: values > 0 && unset === values };
}
