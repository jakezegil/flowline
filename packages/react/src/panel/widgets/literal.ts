/**
 * Typed right-hand literals of the rules and cases widgets: text typed into a rule's "Compare
 * with" becomes a literal of the left value's type (`"5"` → `5` for a number), and the
 * `rule.literalType` warning flags literals that strict mode can never match.
 *
 * @module
 */
import { type Issue, isRef, isTpl, type RuleValueType } from "@flowlinejs/core";
import { defaultLabels } from "../../labels";

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

/**
 * The `rule.literalType` warning when, in `"strict"` mode, `rule` compares a `leftType` value
 * with a literal of another type (e.g. `"5"` on a number field), which strict mode never
 * matches. Nothing for loose mode, references and templates, empty values, unary and host
 * operators, and left values without a single literal type (lists, objects, any). `"in"` wants
 * a list of literals of `leftType`. `message` words the warning (default
 * `defaultLabels.literalTypeWarning`).
 */
export function literalTypeIssue(
  rule: RuleLike,
  leftType: RuleValueType,
  compare: CompareMode,
  message: (leftType: string) => string = defaultLabels.literalTypeWarning,
): Issue | undefined {
  const want = LITERAL_TYPE[leftType];
  const right = rule.right;
  if (compare !== "strict" || !want || !BINARY.has(rule.op)) return undefined;
  if (right === undefined || right === "" || isExpr(right)) return undefined;
  const fits = (v: unknown) => typeof v === want || isExpr(v);
  const ok = rule.op === "in" ? Array.isArray(right) && right.every(fits) : fits(right);
  return ok
    ? undefined
    : { code: "rule.literalType", severity: "warning", message: message(leftType) };
}

function isExpr(v: unknown): boolean {
  return isRef(v) || isTpl(v);
}
