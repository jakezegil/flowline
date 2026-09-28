/**
 * Renders a node's `summary` template (e.g. `"Load {{contactId}}"`) against a step's config for
 * its card: `{{key}}` is a config path; literal values render as text, references as pills
 * labelled like `Trigger › contactId` or `Load contact › email`.
 *
 * @module
 */

import {
  configValueAt,
  isRef,
  isTpl,
  parseRefPath,
  parseTemplate,
  type RefPath,
  type Step,
  type ValueExpr,
} from "@flowkit/core";

/** A chunk of a rendered summary. */
export type SummaryPart =
  | { kind: "text"; text: string }
  | { kind: "ref"; label: string; ref: string }
  /** A config value that is not set yet, shown by the field's name. */
  | { kind: "empty"; label: string };

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
export function refLabel(ref: string, stepName: (id: string) => string | undefined): string {
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
      return join("Trigger", rest);
    case "steps": {
      const id = path.stepId as string;
      return join(stepName(id) ?? id, rest);
    }
    case "loop":
      return path.segments[0] === "index"
        ? "Loop index"
        : join("Item", pathLabel(path.segments.slice(1)));
    case "run":
      return "Run ID";
    default:
      return ref;
  }
}

/** The step IDs referenced by the values the summary template of `step` reads. */
export function summaryStepRefs(summary: string | undefined, step: Step): string[] {
  if (!summary) return [];
  const ids = new Set<string>();
  const visit = (ref: string) => {
    try {
      const p = parseRefPath(ref);
      if (p.root === "steps" && p.stepId) ids.add(p.stepId);
    } catch {
      // Invalid refs are labelled verbatim.
    }
  };
  for (const part of parseTemplate(summary)) {
    if (!("ref" in part)) continue;
    const value = configValueAt(step.config, part.ref) as ValueExpr | undefined;
    if (isRef(value)) visit(value.$ref);
    else if (isTpl(value)) {
      for (const p of parseTemplate(value.$tpl)) if ("ref" in p) visit(p.ref);
    }
  }
  return [...ids];
}

function valueParts(
  value: ValueExpr | undefined,
  key: string,
  stepName: (id: string) => string | undefined,
): SummaryPart[] {
  if (value === undefined || value === null || value === "") return [{ kind: "empty", label: key }];
  if (isRef(value))
    return [{ kind: "ref", ref: value.$ref, label: refLabel(value.$ref, stepName) }];
  if (isTpl(value)) {
    return parseTemplate(value.$tpl).map((p) =>
      "text" in p
        ? { kind: "text", text: truncate(p.text) }
        : { kind: "ref", ref: p.ref, label: refLabel(p.ref, stepName) },
    );
  }
  if (Array.isArray(value)) {
    return [{ kind: "text", text: value.length === 1 ? "1 item" : `${value.length} items` }];
  }
  if (typeof value === "object") return [{ kind: "text", text: "…" }];
  return [{ kind: "text", text: truncate(String(value)) }];
}

/**
 * Renders `summary` against `step.config`. Adjacent text parts are merged; `{{key}}` of an unset
 * value becomes an `empty` part labelled by the last path segment of `key`.
 */
export function renderSummary(
  summary: string,
  step: Step,
  stepName: (id: string) => string | undefined,
): SummaryPart[] {
  const out: SummaryPart[] = [];
  for (const part of parseTemplate(summary)) {
    const parts: SummaryPart[] =
      "text" in part
        ? [{ kind: "text", text: part.text }]
        : valueParts(
            configValueAt(step.config, part.ref) as ValueExpr | undefined,
            part.ref.split(".").pop() ?? part.ref,
            stepName,
          );
    for (const p of parts) {
      const last = out[out.length - 1];
      if (p.kind === "text" && last?.kind === "text") last.text += p.text;
      else out.push(p.kind === "text" ? { ...p } : p);
    }
  }
  return out;
}
