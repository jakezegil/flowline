/**
 * Rule groups: the condition format of `core.condition`, its evaluator and code-first helpers.
 *
 * @module
 */
import {
  FatalError,
  type RuleOperatorMeta,
  type RuleValueType,
  type UiMeta,
  ui,
} from "@flowlinejs/core";
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
  /**
   * How to compare: a built-in {@link RuleOp}, or the id of a {@link CustomOperator} registered
   * with `createBuiltinPlugin({ operators })`.
   */
  op: RuleOp | (string & {});
  /** The value to compare against. Not used by unary operators. */
  right?: unknown;
  /**
   * Compare text case-sensitively (`eq`, `neq`, `contains`, `notContains`, `startsWith`,
   * `endsWith`, `in`). Default `false`: `"Won"` equals `"won"`. Only used in `"loose"` mode:
   * `"strict"` always matches case.
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

/**
 * How a rule set compares values (see {@link evaluateRules}):
 * - `"loose"`: numeric text as numbers, `"true"`/`"false"` as booleans, ISO dates by instant,
 *   `null` equals a missing value, text ignoring case unless `caseSensitive` (`"5"` equals `5`);
 * - `"strict"`: values of the same type only, with no conversion and case-sensitive text
 *   (`"5"` does not equal `5`).
 */
export type CompareMode = "strict" | "loose";

/** Every {@link CompareMode}. */
const COMPARE_MODES = ["strict", "loose"] as const satisfies readonly CompareMode[];

/** The top-level group of a condition: a rule group plus the compare mode. */
export interface ConditionRules extends RuleGroup {
  /**
   * How the rules compare values; nested groups use the same mode. Default: the mode
   * `createBuiltinPlugin` was given, else `"loose"`.
   */
  compare?: CompareMode;
}

/**
 * A host-registered rule operator, e.g. `isUnassigned`, registered with
 * `createBuiltinPlugin({ operators })`. `core.condition` evaluates it (switch cases don't use
 * operators); the editor offers it through the manifest (`UiMeta.operators`).
 *
 * @example
 * ```ts
 * const isUnassigned: CustomOperator = {
 *   id: "isUnassigned", label: "is unassigned", arity: "unary",
 *   types: ["string", "object", "any"],
 *   evaluate: (left) => left === null || left === undefined || left === "",
 * };
 * ```
 */
export interface CustomOperator {
  /** Operator id used in rules, e.g. `"isUnassigned"`. Must not collide with a built-in {@link RuleOp}. */
  id: string;
  /** Editor label, e.g. `"is unassigned"`. */
  label: string;
  /** `unary` operators take no right-hand value; `binary` ones do. */
  arity: "unary" | "binary";
  /** Left-value types the editor offers it for. Default: every type. */
  types?: RuleValueType[];
  /**
   * Evaluate a resolved rule. A unary operator always gets `right === undefined`; a binary one
   * gets the rule's `right` (`undefined` when unset). `ctx.compare` is the rule set's mode, for
   * operators that honour it. Throwing fails the step fatally (a bug in host code, not a
   * retryable condition).
   */
  evaluate(left: unknown, right: unknown, ctx: { compare: CompareMode }): boolean;
}

/** Options of {@link evaluateRules}. */
export interface EvaluateOptions {
  /** Compare mode when the group sets none. Default `"loose"`. */
  compare?: CompareMode;
  /** Host operators by id (from `createBuiltinPlugin({ operators })`). */
  operators?: Readonly<Record<string, CustomOperator>>;
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

/** A rule schema around an operator field. */
const ruleSchema = <Op extends z.ZodType>(op: Op) =>
  z.object({
    left: ui(z.unknown(), { label: "Value" }),
    op,
    right: ui(z.unknown(), { label: "Compare with" })
      .describe(
        'In Loose mode numbers and text compare loosely ("5" equals 5); Strict mode compares values of the same type only. Dates and times are UTC unless they include an offset. For "is one of", give a list (Loose mode also takes comma-separated text).',
      )
      .optional(),
    caseSensitive: ui(z.boolean(), { label: "Match case" })
      .describe('Off by default, so "Won" equals "won". Strict mode always matches case.')
      .optional(),
  });

/** Zod schema of a {@link Rule} with a built-in operator, with editor labels and help text. */
export const RuleSchema = ruleSchema(ui(z.enum(RULE_OPS), { label: "Operator" }));

const combinator = () =>
  ui(z.enum(["and", "or"]), { label: "Match" }).describe(
    "and: every rule must match. or: at least one rule must match.",
  );

/** A rule group schema whose rules use `rule`; groups nest to any depth. */
function ruleGroupSchema(rule: z.ZodType<Rule, Rule>): z.ZodType<RuleGroup, RuleGroup> {
  const group: z.ZodType<RuleGroup, RuleGroup> = z.object({
    combinator: combinator(),
    get rules() {
      return ui(z.array(z.union([rule, group])), { label: "Rules" });
    },
  });
  return group;
}

/** Zod schema of a {@link RuleGroup} with built-in operators; groups nest to any depth. */
export const RuleGroupSchema: z.ZodType<RuleGroup, RuleGroup> = ruleGroupSchema(RuleSchema);

/** Options of {@link createConditionRulesSchema}. */
export interface ConditionRulesSchemaOptions {
  /** Default of the `compare` field, published in the manifest. */
  defaultCompare: CompareMode;
  /** Host operators the `op` field accepts after the built-in ones. */
  operators: readonly CustomOperator[];
}

/**
 * Zod schema of the top-level group of a condition ({@link ConditionRules}): its `compare` field
 * defaults to `defaultCompare`, and its rules (nested ones included) accept the built-in
 * operators plus `operators`, whose labels travel in the `op` field's `enumLabels` and
 * `operators` editor hints. The validator warns when the group has no rules.
 * `createBuiltinPlugin` uses it; hosts rarely need it directly.
 */
export function createConditionRulesSchema(
  opts: ConditionRulesSchemaOptions,
): z.ZodType<ConditionRules, ConditionRules> {
  const { defaultCompare, operators } = opts;
  let rule: z.ZodType<Rule, Rule> = RuleSchema;
  let group = RuleGroupSchema;
  if (operators.length > 0) {
    const meta: UiMeta = {
      label: "Operator",
      enumLabels: Object.fromEntries(operators.map((o) => [o.id, o.label])),
      operators: operators.map(operatorMeta),
    };
    const ids = [...RULE_OPS, ...operators.map((o) => o.id)] as [string, ...string[]];
    rule = ruleSchema(ui(z.enum(ids), meta));
    group = ruleGroupSchema(rule);
  }
  return z.object({
    combinator: combinator(),
    rules: ui(z.array(z.union([rule, group])), {
      label: "Rules",
      warnIfEmpty: "Condition has no rules, so it always takes the same path",
    }),
    compare: compareSchema(defaultCompare),
  });
}

/** The editor metadata of a custom operator (everything but `evaluate`). */
function operatorMeta({ id, label, arity, types }: CustomOperator): RuleOperatorMeta {
  return types === undefined ? { id, label, arity } : { id, label, arity, types: [...types] };
}

/**
 * Zod schema of a `compare` field defaulting to `defaultCompare`, as `core.condition`'s rules and
 * `core.switch` use it.
 */
export function compareSchema(
  defaultCompare: CompareMode,
): z.ZodDefault<z.ZodEnum<{ strict: "strict"; loose: "loose" }>> {
  return ui(z.enum(COMPARE_MODES), {
    label: "Compare",
    enumLabels: { strict: "Strict", loose: "Loose" },
  })
    .describe(
      'Strict: values must have the same type and text must match case ("5" does not equal 5). Loose: numeric text, "true"/"false" and dates are converted, and text ignores case unless Match case is on.',
    )
    .default(defaultCompare);
}

/**
 * Zod schema of the top-level group of a condition with the built-in operators and a `"loose"`
 * default: `createConditionRulesSchema({ defaultCompare: "loose", operators: [] })`.
 */
export const ConditionRulesSchema: z.ZodType<ConditionRules, ConditionRules> =
  createConditionRulesSchema({ defaultCompare: "loose", operators: [] });

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

/** An object literal (prototype `Object.prototype` or `null`), not a class instance. */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const isUnset = (v: unknown): v is null | undefined => v === null || v === undefined;

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

/**
 * Equality of `"strict"` mode: `===` for primitives (so `NaN` never equals itself, and `-0`
 * equals `0`), arrays deeply by index, plain objects deeply by own keys (key order doesn't
 * matter); anything else (dates, class instances) is not equal. `null` and `undefined` are
 * different values.
 */
export function strictEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => strictEquals(v, b[i]));
  }
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && strictEquals(a[k], b[k]))
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

/**
 * A substring of text `haystack` (numbers and booleans as text), or an item of list `haystack`
 * equal to `needle`.
 */
function containsValue(haystack: unknown, needle: unknown, caseSensitive: boolean): boolean {
  if (Array.isArray(haystack)) {
    return haystack.some((item) => looseEquals(item, needle, { caseSensitive }));
  }
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

/** A rule with a built-in operator in `"loose"` mode. */
function evaluateLoose({ left, op, right, caseSensitive = false }: Rule): boolean {
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

/**
 * Two numbers, or two strings (by instant when both are ISO dates, else by code unit), as a pair
 * of comparable keys; `undefined` for any other pair.
 */
function strictOrderable(a: unknown, b: unknown): [number, number] | [string, string] | undefined {
  if (typeof a === "number" && typeof b === "number") return [a, b];
  if (typeof a !== "string" || typeof b !== "string") return undefined;
  const ta = asTimestamp(a);
  const tb = asTimestamp(b);
  return ta !== undefined && tb !== undefined ? [ta, tb] : [a, b];
}

/** `"strict"` contains: a case-sensitive substring of text, or an item `strictEquals` `right`. */
function strictContains(left: unknown, right: unknown): boolean {
  if (isUnset(left) || isUnset(right)) return false;
  if (Array.isArray(left)) return left.some((item) => strictEquals(item, right));
  return typeof left === "string" && typeof right === "string" && left.includes(right);
}

/** A rule with a built-in operator in `"strict"` mode. `caseSensitive` is ignored. */
function evaluateStrict({ left, op, right }: Rule): boolean {
  switch (op) {
    case "eq":
      return strictEquals(left, right);
    case "neq":
      return !strictEquals(left, right);
    case "contains":
      return strictContains(left, right);
    case "notContains":
      return !strictContains(left, right);
    case "isEmpty":
      return isEmptyValue(left);
    case "isNotEmpty":
      return !isEmptyValue(left);
    case "isTrue":
      return left === true;
    case "isFalse":
      return left === false;
  }
  // Every other binary operator is false when either side is unset.
  if (isUnset(left) || isUnset(right)) return false;
  switch (op) {
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const pair = strictOrderable(left, right);
      if (!pair) return false;
      const [a, b] = pair;
      if (op === "gt") return a > b;
      if (op === "gte") return a >= b;
      if (op === "lt") return a < b;
      return a <= b;
    }
    case "startsWith":
    case "endsWith":
      if (typeof left !== "string" || typeof right !== "string") return false;
      return op === "startsWith" ? left.startsWith(right) : left.endsWith(right);
    case "in":
      return Array.isArray(right) && right.some((item) => strictEquals(left, item));
    default:
      return false;
  }
}

const BUILTIN_OPS: ReadonlySet<string> = new Set(RULE_OPS);

/** `id` is a built-in {@link RuleOp}, so no {@link CustomOperator} may use it. */
export const isBuiltinRuleOp = (id: string): id is RuleOp => BUILTIN_OPS.has(id);

type Operators = Readonly<Record<string, CustomOperator>>;

function evaluateRule(rule: Rule, compare: CompareMode, operators: Operators): boolean {
  if (isBuiltinRuleOp(rule.op)) {
    return compare === "strict" ? evaluateStrict(rule) : evaluateLoose(rule);
  }
  const operator = Object.hasOwn(operators, rule.op) ? operators[rule.op] : undefined;
  if (!operator) return false;
  const right = operator.arity === "unary" ? undefined : rule.right;
  try {
    return operator.evaluate(rule.left, right, { compare }) === true;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new FatalError(`Rule operator "${rule.op}" threw: ${reason}`, { cause });
  }
}

const isGroup = (r: Rule | RuleGroup): r is RuleGroup => "combinator" in r;

function evaluateGroup(g: RuleGroup, compare: CompareMode, operators: Operators): boolean {
  const results = (item: Rule | RuleGroup) =>
    isGroup(item)
      ? evaluateGroup(item, compare, operators)
      : evaluateRule(item, compare, operators);
  return g.combinator === "or" ? g.rules.some(results) : g.rules.every(results);
}

/**
 * Evaluate a rule group whose values are already resolved.
 *
 * The compare mode is the group's `compare` ({@link ConditionRules}), else `opts.compare`, else
 * `"loose"`; nested groups use the top-level mode. In `"loose"` mode:
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
 *
 * In `"strict"` mode values compare only with values of the same type: no numeric or boolean
 * parsing of text, no case folding (`caseSensitive` is ignored), no comma-separated lists.
 *
 * - `eq`/`neq` use {@link strictEquals}; `null` and a missing value are different.
 * - `gt`/`gte`/`lt`/`lte` compare two numbers, or two strings (by instant when both are ISO
 *   dates, else by code unit).
 * - `contains` looks for a substring when both sides are text, or for an item that
 *   `strictEquals` `right` in list `left`; `notContains` is its opposite. `startsWith`/`endsWith`
 *   need two strings; `in` needs list `right`.
 * - The other binary operators (all but `eq`, `neq` and `notContains`) are false when either
 *   side is `null` or missing. `isEmpty`/`isNotEmpty` work as in loose mode; `isTrue`/`isFalse`
 *   match only `true`/`false`.
 *
 * In both modes, a rule whose `op` is one of `opts.operators` is evaluated by that
 * {@link CustomOperator} (a unary one gets `right === undefined`); one that throws fails with a
 * `FatalError` naming the operator. Any other unknown operator never matches.
 */
export function evaluateRules(g: RuleGroup | ConditionRules, opts: EvaluateOptions = {}): boolean {
  const compare = ("compare" in g ? g.compare : undefined) ?? opts.compare ?? "loose";
  return evaluateGroup(g, compare, opts.operators ?? {});
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

/** `group` as a condition's top-level rules, compared strictly: `{ ...group, compare: "strict" }`. */
export function strictly(group: RuleGroup): ConditionRules {
  return { ...group, compare: "strict" };
}

/** `group` as a condition's top-level rules, compared loosely: `{ ...group, compare: "loose" }`. */
export function loosely(group: RuleGroup): ConditionRules {
  return { ...group, compare: "loose" };
}

/**
 * A rule using a host-registered operator ({@link CustomOperator}), e.g.
 * `custom("isUnassigned", ref("trigger.deal.ownerId"))`. Leave `right` out for a unary operator.
 */
export function custom(op: string, left: unknown, right?: unknown): Rule {
  return right === undefined ? { left, op } : { left, op, right };
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

/**
 * `left` equals `right` in the rule set's compare mode: loosely by default (see
 * {@link looseEquals}; case-insensitive unless `caseSensitive`), else {@link strictEquals}.
 */
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
