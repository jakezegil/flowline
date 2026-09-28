/**
 * Rule groups: the condition format of `core.condition`, its evaluator and code-first helpers.
 *
 * @module
 */
import { ui } from "@flowline/core";
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
  /**
   * Compare text case-sensitively (`eq`, `neq`, `contains`, `notContains`, `startsWith`,
   * `endsWith`, `in`). Default `false`: `"Won"` equals `"won"`.
   */
  caseSensitive?: boolean;
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

/** Zod schema of a {@link Rule}, with editor labels and help text. */
export const RuleSchema = z.object({
  left: ui(z.unknown(), { label: "Value" }),
  op: ui(z.enum(RULE_OPS), { label: "Operator" }),
  right: ui(z.unknown(), { label: "Compare with" })
    .describe(
      'Numbers and text compare loosely ("5" equals 5). Dates and times are UTC unless they include an offset. For "is one of", give a list or comma-separated text.',
    )
    .optional(),
  caseSensitive: ui(z.boolean(), { label: "Match case" })
    .describe('Off by default, so "Won" equals "won".')
    .optional(),
});

const combinator = () =>
  ui(z.enum(["and", "or"]), { label: "Match" }).describe(
    "and: every rule must match. or: at least one rule must match.",
  );

/** Zod schema of a {@link RuleGroup}; groups nest to any depth. */
export const RuleGroupSchema: z.ZodType<RuleGroup, RuleGroup> = z.object({
  combinator: combinator(),
  get rules() {
    return ui(z.array(z.union([RuleSchema, RuleGroupSchema])), { label: "Rules" });
  },
});

/**
 * Zod schema of the top-level group of a condition: a {@link RuleGroup} for which the validator
 * warns when it has no rules.
 */
export const ConditionRulesSchema: z.ZodType<RuleGroup, RuleGroup> = z.object({
  combinator: combinator(),
  rules: ui(z.array(z.union([RuleSchema, RuleGroupSchema])), {
    label: "Rules",
    warnIfEmpty: "Condition has no rules, so it always takes the same path",
  }),
});

const NUMERIC = /^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i;
/**
 * ISO 8601 date or date-time: `2026-01-31`, `2026-01-31T09:00`, `2026-01-31 09:00:00.5+01:00`, …
 * Groups: date, time, offset.
 */
const ISO_DATE =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?$/;

/** A finite number, or a string that reads as one; otherwise `undefined`. */
function asNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && NUMERIC.test(v)) return Number(v);
  return undefined;
}

/**
 * Epoch ms of an ISO 8601 date string, otherwise `undefined`. Dates and date-times without an
 * offset are UTC (never the server's time zone), so results don't depend on where the engine runs.
 */
function asTimestamp(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const m = ISO_DATE.exec(v);
  if (!m) return undefined;
  const [, date, time = "00:00", offset] = m;
  const zone =
    offset === undefined || offset === "Z"
      ? "Z"
      : offset.includes(":")
        ? offset
        : `${offset.slice(0, 3)}:${offset.slice(3)}`;
  const t = Date.parse(`${date}T${time}${zone}`);
  return Number.isNaN(t) ? undefined : t;
}

/** `true`/`"true"` → true, `false`/`"false"` → false (as `isTrue`/`isFalse` read them). */
function asBoolean(v: unknown): boolean | undefined {
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return undefined;
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

/** Options of {@link looseEquals}. */
export interface EqualsOptions {
  /** Compare text case-sensitively. Default `true`. */
  caseSensitive?: boolean;
}

/**
 * Equality as users expect it in conditions:
 * - numbers and numeric text compare as numbers (`"5"` equals `5` and `"5.0"`);
 * - booleans compare as `isTrue`/`isFalse` read them (`true` equals `"true"`);
 * - ISO dates are equal when they name the same instant (UTC unless an offset is given);
 * - `null` equals `undefined` (a missing value);
 * - arrays and objects compare deeply (object key order doesn't matter);
 * - other text compares exactly, or ignoring case with `caseSensitive: false`.
 */
export function looseEquals(a: unknown, b: unknown, opts: EqualsOptions = {}): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a === null || a === undefined) && (b === null || b === undefined);
  }
  if (typeof a === "boolean" || typeof b === "boolean") {
    const ba = asBoolean(a);
    return ba !== undefined && ba === asBoolean(b);
  }
  const na = asNumber(a);
  const nb = asNumber(b);
  if (typeof a === "number" || typeof b === "number") return na !== undefined && na === nb;
  if (typeof a === "string" && typeof b === "string") {
    if (na !== undefined && nb !== undefined) return na === nb;
    const ta = asTimestamp(a);
    const tb = asTimestamp(b);
    if (ta !== undefined && tb !== undefined) return ta === tb;
    return opts.caseSensitive === false && a.toLowerCase() === b.toLowerCase();
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => looseEquals(v, b[i], opts));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && looseEquals(a[k], b[k], opts))
    );
  }
  return false;
}

/** Text form of a primitive for text operators (lower-cased unless case-sensitive). */
function asText(v: unknown, caseSensitive: boolean): string | undefined {
  const text =
    typeof v === "string"
      ? v
      : typeof v === "number" || typeof v === "boolean"
        ? String(v)
        : undefined;
  return text !== undefined && !caseSensitive ? text.toLowerCase() : text;
}

/** A substring of text `haystack`, or an item of list `haystack` equal to `needle`. */
function containsValue(haystack: unknown, needle: unknown, caseSensitive: boolean): boolean {
  if (Array.isArray(haystack)) {
    return haystack.some((item) => looseEquals(item, needle, { caseSensitive }));
  }
  if (typeof haystack !== "string") return false;
  const text = asText(haystack, caseSensitive);
  const part = asText(needle, caseSensitive);
  return text !== undefined && part !== undefined && text.includes(part);
}

/** `left` is an item of list `right`, or of comma-separated text `right` (items trimmed). */
function isInList(left: unknown, right: unknown, caseSensitive: boolean): boolean {
  const items = Array.isArray(right)
    ? right
    : typeof right === "string"
      ? right.split(",").map((item) => item.trim())
      : undefined;
  return items?.some((item) => looseEquals(left, item, { caseSensitive })) ?? false;
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  return isPlainObject(v) && Object.keys(v).length === 0;
}

function evaluateRule({ left, op, right, caseSensitive = false }: Rule): boolean {
  switch (op) {
    case "eq":
      return looseEquals(left, right, { caseSensitive });
    case "neq":
      return !looseEquals(left, right, { caseSensitive });
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
      return containsValue(left, right, caseSensitive);
    case "notContains":
      return !containsValue(left, right, caseSensitive);
    case "startsWith":
    case "endsWith": {
      const text = asText(left, caseSensitive);
      const part = asText(right, caseSensitive);
      if (text === undefined || part === undefined) return false;
      return op === "startsWith" ? text.startsWith(part) : text.endsWith(part);
    }
    case "in":
      return isInList(left, right, caseSensitive);
    case "isEmpty":
      return isEmptyValue(left);
    case "isNotEmpty":
      return !isEmptyValue(left);
    case "isTrue":
      return asBoolean(left) === true;
    case "isFalse":
      return asBoolean(left) === false;
    default:
      return false;
  }
}

const isGroup = (r: Rule | RuleGroup): r is RuleGroup => "combinator" in r;

/**
 * Evaluate a rule group whose values are already resolved.
 *
 * - Text comparisons (`eq`, `neq`, `contains`, `notContains`, `startsWith`, `endsWith`, `in`)
 *   ignore case unless the rule sets `caseSensitive: true`.
 * - `eq`/`neq` compare loosely (see {@link looseEquals}): `"5"` equals `5`, `true` equals
 *   `"true"`, ISO dates by instant.
 * - `gt`/`gte`/`lt`/`lte` compare numbers (numeric text included), then ISO dates as timestamps,
 *   then text alphabetically; any other pair is not ordered and never matches.
 * - Dates and date-times are UTC unless they include an offset, whatever the server's time zone.
 * - `contains`/`notContains` look for a substring in text or an item in a list. `in` checks that
 *   `left` is an item of list `right`, or of comma-separated text `right` (`"won, lost"`).
 *   `startsWith`/`endsWith` work on text.
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

/** Options of the binary rule helpers. */
export interface RuleOptions {
  /** Compare text case-sensitively. Default `false`. */
  caseSensitive?: boolean;
}

type BinaryHelper = (left: unknown, right: unknown, opts?: RuleOptions) => Rule;

const binary =
  (op: RuleOp): BinaryHelper =>
  (left, right, opts) =>
    opts?.caseSensitive === undefined
      ? { left, op, right }
      : { left, op, right, caseSensitive: opts.caseSensitive };
const unary =
  (op: RuleOp) =>
  (left: unknown): Rule => ({ left, op });

/** `left` equals `right` (loosely, see {@link looseEquals}; case-insensitive by default). */
export const eq: BinaryHelper = binary("eq");
/** `left` does not equal `right`. */
export const neq: BinaryHelper = binary("neq");
/** `left` is greater than `right`. */
export const gt: BinaryHelper = binary("gt");
/** `left` is greater than or equal to `right`. */
export const gte: BinaryHelper = binary("gte");
/** `left` is less than `right`. */
export const lt: BinaryHelper = binary("lt");
/** `left` is less than or equal to `right`. */
export const lte: BinaryHelper = binary("lte");
/** Text `left` contains `right`, or list `left` has an item equal to `right`. */
export const contains: BinaryHelper = binary("contains");
/** The opposite of `contains`. */
export const notContains: BinaryHelper = binary("notContains");
/** Text `left` starts with `right`. */
export const startsWith: BinaryHelper = binary("startsWith");
/** Text `left` ends with `right`. */
export const endsWith: BinaryHelper = binary("endsWith");
/** `left` is an item of list `right`, or of comma-separated text `right`. Op `"in"`. */
export const isIn: BinaryHelper = binary("in");
/** `left` is missing, `null`, `""`, `[]` or `{}`. */
export const isEmpty: (left: unknown) => Rule = unary("isEmpty");
/** The opposite of `isEmpty`. */
export const isNotEmpty: (left: unknown) => Rule = unary("isNotEmpty");
/** `left` is `true` (or `"true"`). */
export const isTrue: (left: unknown) => Rule = unary("isTrue");
/** `left` is `false` (or `"false"`). */
export const isFalse: (left: unknown) => Rule = unary("isFalse");
