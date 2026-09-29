/**
 * Typed right-hand literals of the rules and cases widgets: text typed into a rule's "Compare
 * with" becomes a literal of the left value's type (`"5"` → `5` for a number), and the
 * `rule.literalType` warning flags literals that strict mode can never match.
 *
 * @module
 */
import { type Issue, isRef, isTpl, type RuleValueType } from "@flowlinejs/core";
import { defaultLabels, type FlowlineLabels } from "../../labels";

/** A literal a rule compares with. */
export type Literal = string | number | boolean;

/** How a rule set compares values (`ConditionRules.compare` of `@flowlinejs/nodes-builtin`). */
export type CompareMode = "strict" | "loose";

/** The parts of a rule the literal check reads. */
export interface RuleLike {
  left?: unknown;
  op: string;
  right?: unknown;
}

/** Numeric text: `5`, `-2.5`, `.5`, `1e3` (surrounding spaces allowed). */
const NUMERIC = /^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i;

/** Built-in operators that compare with a right-hand value (host operators check their own). */
const BINARY = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "in",
]);

/** The JavaScript type a literal compared with a `type` value has, when there is one. */
const LITERAL_TYPE: Partial<Record<RuleValueType, "string" | "number" | "boolean">> = {
  string: "string",
  date: "string",
  number: "number",
  boolean: "boolean",
};

/**
 * `text` as a literal of `type`: a number for number values (`"5"` → `5`), `true`/`false` for
 * true/false values, else the text itself (also when it isn't a number or `true`/`false`).
 */
export function toTypedLiteral(text: string, type: RuleValueType): Literal {
  if (type === "number" && NUMERIC.test(text)) {
    const n = Number(text);
    if (Number.isFinite(n)) return n;
  }
  if (type === "boolean") {
    const t = text.trim();
    if (t === "true") return true;
    if (t === "false") return false;
  }
  return text;
}

/** Comma-separated `text` as a list of literals of `type`: `"5, 7"` → `[5, 7]`. */
export function toTypedList(text: string, type: RuleValueType): Literal[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => toTypedLiteral(item, type));
}

/** The text a literal (or list of literals) is edited as: `[5, 7]` → `"5, 7"`. */
export function literalText(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.every((x) => ["string", "number", "boolean"].includes(typeof x))) {
    return v.join(", ");
  }
  return undefined;
}

/** Options of {@link literalTypeIssue}. */
export interface LiteralTypeIssueOptions {
  /** Labels in effect (default {@link defaultLabels}). */
  labels?: FlowlineLabels;
  /** Name of the compared value's field (default `labels.ruleLeft`). */
  leftLabel?: string;
  /** Name of the literal's field (default `labels.ruleRight`). */
  rightLabel?: string;
}

/**
 * The `rule.literalType` warning when, in `"strict"` mode, `rule` compares a `leftType` value
 * with a literal of another type (e.g. `"5"` on a number field), which strict mode never
 * matches. `"in"` wants a list of literals of `leftType`; a template (text with a reference)
 * counts as text. Nothing for loose mode, references, empty values, unary and host operators,
 * and left values without a single literal type (lists, objects, any). The message names the
 * fields by `leftLabel`/`rightLabel` and says what each value actually is.
 */
export function literalTypeIssue(
  rule: RuleLike,
  leftType: RuleValueType,
  compare: CompareMode,
  opts: LiteralTypeIssueOptions = {},
): Issue | undefined {
  const want = LITERAL_TYPE[leftType];
  const right = rule.right;
  if (compare !== "strict" || !want || !BINARY.has(rule.op)) return undefined;
  if (right === undefined || right === "" || isRef(right)) return undefined;
  const list = rule.op === "in";
  const fits = (v: unknown) => isRef(v) || (isTpl(v) ? want === "string" : typeof v === want);
  const ok = list ? Array.isArray(right) && right.every(fits) : fits(right);
  if (ok) return undefined;
  const labels = opts.labels ?? defaultLabels;
  const kind = (v: unknown): string => {
    if (isTpl(v)) return labels.literalKinds.template;
    if (Array.isArray(v)) {
      const odd = v.find((item) => !fits(item));
      return odd === undefined ? labels.literalKinds.list : labels.literalListIncludes(kind(odd));
    }
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      return labels.literalKinds[typeof v as "string" | "number" | "boolean"];
    }
    return labels.literalKinds.object;
  };
  const leftKind = labels.literalKinds[leftType as "string" | "number" | "boolean" | "date"];
  const plural = labels.literalKindsPlural[leftType as "string" | "number" | "boolean" | "date"];
  return {
    code: "rule.literalType",
    severity: "warning",
    message: labels.literalTypeWarning({
      rightLabel: opts.rightLabel ?? labels.ruleRight,
      rightType: kind(right),
      leftLabel: opts.leftLabel ?? labels.ruleLeft,
      leftType: list ? labels.literalNeedsList(leftKind, plural) : leftKind,
    }),
  };
}
