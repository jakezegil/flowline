/**
 * Rule groups: the condition format of `core.condition`, its evaluator and code-first helpers.
 *
 * @module
 */
import { z } from "zod";

/** Comparison operators a {@link Rule} can use. */
export type RuleOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "in"
  | "isEmpty"
  | "isNotEmpty"
  | "isTrue"
  | "isFalse";

/** One comparison: `left <op> right`. Unary operators (`isEmpty`, `isTrue`, …) ignore `right`. */
export interface Rule {
  /** The value being tested, usually a reference such as `trigger.deal.stage`. */
  left: unknown;
  /** How to compare. */
  op: RuleOp;
  /** The value to compare against. Not used by unary operators. */
  right?: unknown;
}

/** Rules (and nested groups) combined with AND or OR. */
export interface RuleGroup {
  /** `and`: every rule must match. `or`: at least one must. */
  combinator: "and" | "or";
  /** The rules and nested groups. */
  rules: (Rule | RuleGroup)[];
}

/** Every {@link RuleOp}, in the order the editor offers them. */
export const RULE_OPS = [
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
  "isEmpty",
  "isNotEmpty",
  "isTrue",
  "isFalse",
] as const satisfies readonly RuleOp[];

/** Zod schema of a {@link Rule}. */
export const RuleSchema = z.object({
  left: z.unknown(),
  op: z.enum(RULE_OPS),
  right: z.unknown().optional(),
});

/** Zod schema of a {@link RuleGroup}; groups nest to any depth. */
export const RuleGroupSchema: z.ZodType<RuleGroup> = z.object({
  combinator: z.enum(["and", "or"]),
  get rules() {
    return z.array(z.union([RuleSchema, RuleGroupSchema]));
  },
});

const NUMERIC = /^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i;
/** ISO 8601 date or date-time (`2026-01-31`, `2026-01-31T09:00:00Z`, …). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** A finite number, or a string that reads as one; otherwise `undefined`. */
function asNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && NUMERIC.test(v)) return Number(v);
  return undefined;
}

/** Epoch ms of an ISO 8601 date string; otherwise `undefined`. */
function asTimestamp(v: unknown): number | undefined {
  if (typeof v !== "string" || !ISO_DATE.test(v)) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * Two numbers, two dates or two strings that can be ordered, as a pair of comparable keys;
 * `undefined` when the values can't be ordered (so every ordering operator is false).
 */
function orderable(a: unknown, b: unknown): [number, number] | [string, string] | undefined {
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== undefined && nb !== undefined) return [na, nb];
  const ta = asTimestamp(a);
  const tb = asTimestamp(b);
  if (ta !== undefined && tb !== undefined) return [ta, tb];
  if (typeof a === "string" && typeof b === "string") return [a, b];
  return undefined;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Equality as users expect it in conditions: `"5"` equals `5`, ISO dates are equal when they
 * name the same instant, `null` equals `undefined` (a missing value), and arrays/objects are
 * compared deeply (object key order doesn't matter). Strings are case-sensitive.
 */
export function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a === null || a === undefined) && (b === null || b === undefined);
  }
  if (typeof a === "number" || typeof b === "number") {
    const na = asNumber(a);
    const nb = asNumber(b);
    return na !== undefined && na === nb;
  }
  if (typeof a === "string" && typeof b === "string") {
    const ta = asTimestamp(a);
    const tb = asTimestamp(b);
    return ta !== undefined && ta === tb;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => looseEquals(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && looseEquals(a[k], b[k]))
    );
  }
  return false;
}

/** Text form of a primitive for text operators; `undefined` for anything else. */
function asText(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

function containsValue(haystack: unknown, needle: unknown): boolean {
  if (Array.isArray(haystack)) return haystack.some((item) => looseEquals(item, needle));
  const text = typeof haystack === "string" ? haystack : undefined;
  const part = asText(needle);
  return text !== undefined && part !== undefined && text.includes(part);
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  return isPlainObject(v) && Object.keys(v).length === 0;
}

function evaluateRule({ left, op, right }: Rule): boolean {
  switch (op) {
    case "eq":
      return looseEquals(left, right);
    case "neq":
      return !looseEquals(left, right);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const pair = orderable(left, right);
      if (!pair) return false;
      const [a, b] = pair;
      if (op === "gt") return a > b;
      if (op === "gte") return a >= b;
      if (op === "lt") return a < b;
      return a <= b;
    }
    case "contains":
      return containsValue(left, right);
    case "notContains":
      return !containsValue(left, right);
    case "startsWith":
    case "endsWith": {
      const text = asText(left);
      const part = asText(right);
      if (text === undefined || part === undefined) return false;
      return op === "startsWith" ? text.startsWith(part) : text.endsWith(part);
    }
    case "in":
      return Array.isArray(right) || typeof right === "string" ? containsValue(right, left) : false;
    case "isEmpty":
      return isEmptyValue(left);
    case "isNotEmpty":
      return !isEmptyValue(left);
    case "isTrue":
      return left === true || left === "true";
    case "isFalse":
      return left === false || left === "false";
    default:
      return false;
  }
}

const isGroup = (r: Rule | RuleGroup): r is RuleGroup => "combinator" in r;

/**
 * Evaluate a rule group whose values are already resolved.
 *
 * - `eq`/`neq` compare loosely (see {@link looseEquals}): `"5"` equals `5`, ISO dates by instant.
 * - `gt`/`gte`/`lt`/`lte` compare numbers (numeric strings included), then ISO dates as
 *   timestamps, then strings alphabetically; any other pair is not ordered and never matches.
 * - `contains`/`notContains` look for a substring in text or an item in a list; `in` is the
 *   reverse (`left` is in the list or text `right`). `startsWith`/`endsWith` work on text.
 * - `isEmpty` matches `null`, a missing value, `""`, `[]` and `{}`; `isTrue`/`isFalse` also accept
 *   the strings `"true"`/`"false"`.
 * - An empty `and` group matches; an empty `or` group doesn't.
 */
export function evaluateRules(g: RuleGroup): boolean {
  const results = (item: Rule | RuleGroup) =>
    isGroup(item) ? evaluateRules(item) : evaluateRule(item);
  return g.combinator === "or" ? g.rules.some(results) : g.rules.every(results);
}

// ---------------------------------------------------------------------------------------------
// Code-first helpers, e.g. `{ rules: and(eq(ref("trigger.deal.stage"), "won")) }`.

/** A group that matches when every rule matches. */
export function and(...rules: (Rule | RuleGroup)[]): RuleGroup {
  return { combinator: "and", rules };
}

/** A group that matches when at least one rule matches. */
export function or(...rules: (Rule | RuleGroup)[]): RuleGroup {
  return { combinator: "or", rules };
}

const binary =
  (op: RuleOp) =>
  (left: unknown, right: unknown): Rule => ({ left, op, right });
const unary =
  (op: RuleOp) =>
  (left: unknown): Rule => ({ left, op });

/** `left` equals `right` (loosely, see {@link looseEquals}). */
export const eq: (left: unknown, right: unknown) => Rule = binary("eq");
/** `left` does not equal `right`. */
export const neq: (left: unknown, right: unknown) => Rule = binary("neq");
/** `left` is greater than `right`. */
export const gt: (left: unknown, right: unknown) => Rule = binary("gt");
/** `left` is greater than or equal to `right`. */
export const gte: (left: unknown, right: unknown) => Rule = binary("gte");
/** `left` is less than `right`. */
export const lt: (left: unknown, right: unknown) => Rule = binary("lt");
/** `left` is less than or equal to `right`. */
export const lte: (left: unknown, right: unknown) => Rule = binary("lte");
/** Text `left` contains `right`, or list `left` has an item equal to `right`. */
export const contains: (left: unknown, right: unknown) => Rule = binary("contains");
/** The opposite of `contains`. */
export const notContains: (left: unknown, right: unknown) => Rule = binary("notContains");
/** Text `left` starts with `right`. */
export const startsWith: (left: unknown, right: unknown) => Rule = binary("startsWith");
/** Text `left` ends with `right`. */
export const endsWith: (left: unknown, right: unknown) => Rule = binary("endsWith");
/** `left` is one of the items of list `right` (or part of text `right`). Op `"in"`. */
export const isIn: (left: unknown, right: unknown) => Rule = binary("in");
/** `left` is missing, `null`, `""`, `[]` or `{}`. */
export const isEmpty: (left: unknown) => Rule = unary("isEmpty");
/** The opposite of `isEmpty`. */
export const isNotEmpty: (left: unknown) => Rule = unary("isNotEmpty");
/** `left` is `true` (or `"true"`). */
export const isTrue: (left: unknown) => Rule = unary("isTrue");
/** `left` is `false` (or `"false"`). */
export const isFalse: (left: unknown) => Rule = unary("isFalse");
