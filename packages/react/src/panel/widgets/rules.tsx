/**
 * The `"rules"` widget: a condition builder for a rule group
 * (`{ combinator: "and" | "or", rules: (Rule | RuleGroup)[], compare? }`, rules `{ left, op,
 * right?, caseSensitive? }`). The top-level group chooses the compare mode (strict or loose,
 * defaulting to the schema default). Operators are filtered by the type of the left value, host
 * operators (`x-flowline.operators` of the `op` field) included; unary operators hide the right
 * value, and right-hand literals are stored in the left value's type (`5`, not `"5"`). Groups
 * nest one level.
 *
 * @module
 */
import {
  isRef,
  isTpl,
  type JSONSchema,
  type RuleOperatorMeta,
  type RuleValueType,
  type ScopeEntry,
  type ValueExpr,
} from "@flowlinejs/core";
import { CaseSensitive, ListPlus, Plus } from "lucide-react";
import { type JSX, useId, useState } from "react";
import { useFlowlineAppearance } from "../../provider";
import { ItemActions, useItemKeys } from "../fields/collections";
import { useRefMode } from "../fields/controls";
import { FieldShell, IssueNotes, RefToggle, Segmented } from "../fields/shell";
import { type FieldProps, useFormEnv } from "../form-context";
import { RefTextInput } from "../ref-text-input";
import {
  deref,
  isAny,
  issuesAt,
  issuesUnder,
  metaOf,
  refSchema,
  typesOf,
  unionMembers,
} from "../schema";
import { asObject } from "../schema-form";
import {
  type CompareMode,
  literalText,
  literalTypeIssue,
  toTypedList,
  toTypedLiteral,
} from "./literal";

type Combinator = "and" | "or";
interface Rule {
  left: ValueExpr;
  op: string;
  right?: ValueExpr;
  caseSensitive?: boolean;
}
interface Group {
  combinator: Combinator;
  rules: (Rule | Group)[];
  /** Top-level group only. */
  compare?: CompareMode;
}

const ALL_OPS = [
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
];
const UNARY = new Set(["isEmpty", "isNotEmpty", "isTrue", "isFalse"]);
const TEXT_OPS = new Set(["eq", "neq", "contains", "notContains", "startsWith", "endsWith", "in"]);

/** The kind of value a rule compares, which decides the operators offered. */
export type ValueType = RuleValueType;

/** Operators that make sense per left-value type (`any` offers everything). */
export const OPS_BY_TYPE: Record<ValueType, string[]> = {
  string: [
    "eq",
    "neq",
    "contains",
    "notContains",
    "startsWith",
    "endsWith",
    "in",
    "isEmpty",
    "isNotEmpty",
  ],
  date: ["eq", "neq", "gt", "gte", "lt", "lte", "isEmpty", "isNotEmpty"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "in", "isEmpty", "isNotEmpty"],
  boolean: ["isTrue", "isFalse", "eq", "neq", "isEmpty", "isNotEmpty"],
  array: ["contains", "notContains", "isEmpty", "isNotEmpty"],
  object: ["isEmpty", "isNotEmpty", "eq", "neq"],
  any: ALL_OPS,
};

function schemaType(s: JSONSchema | undefined, depth = 0): ValueType {
  if (!s || isAny(s) || depth > 4) return "any";
  const members = unionMembers(s, s)?.filter((m) => m.type !== "null");
  if (members && members.length > 0) {
    const kinds = new Set(members.map((m) => schemaType(m, depth + 1)));
    return kinds.size === 1 ? ([...kinds][0] as ValueType) : "any";
  }
  const types = typesOf(s)?.filter((t) => t !== "null");
  const t = types?.length === 1 ? types[0] : Array.isArray(s.enum) ? typeof s.enum[0] : undefined;
  if (t === "string") return s.format === "date-time" || s.format === "date" ? "date" : "string";
  if (t === "number" || t === "integer") return "number";
  if (t === "boolean") return "boolean";
  if (t === "array") return "array";
  if (t === "object") return "object";
  return "any";
}

/** The type of a rule's left value: a reference's schema type, text for templates, else literal. */
export function valueTypeOf(v: ValueExpr | undefined, scope: ScopeEntry[]): ValueType {
  if (isRef(v)) return schemaType(refSchema(v.$ref, scope));
  if (isTpl(v)) return "string";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "string" && v !== "") return "string";
  return "any";
}

/** A compare mode value, or `undefined`. */
export function asCompare(v: unknown): CompareMode | undefined {
  return v === "strict" || v === "loose" ? v : undefined;
}

/** The default of an object schema's `compare` property (`"loose"` when it has none). */
export function compareDefault(root: JSONSchema, schema: JSONSchema): CompareMode {
  const props = deref(root, schema).properties as Record<string, unknown> | undefined;
  return asCompare(deref(root, props?.compare).default) ?? "loose";
}

function isGroup(v: unknown): v is Group {
  const o = asObject(v as ValueExpr);
  return o !== undefined && Array.isArray(o.rules);
}

function asGroup(v: ValueExpr | undefined): Group {
  const o = asObject(v);
  const combinator = o?.combinator === "or" ? "or" : "and";
  const rules = Array.isArray(o?.rules) ? (o.rules as unknown as (Rule | Group)[]) : [];
  const compare = asCompare(o?.compare);
  return compare ? { combinator, rules, compare } : { combinator, rules };
}

/** `group` with every rule's `caseSensitive` removed (nested groups included). */
function withoutMatchCase(group: Group): Group {
  return {
    ...group,
    rules: group.rules.map((r) => {
      if (isGroup(r)) return withoutMatchCase(r);
      const { caseSensitive: _c, ...rest } = r;
      return rest;
    }),
  };
}

/** The operators a rule schema offers: allowed ids in schema order, host operators and labels. */
interface OperatorSet {
  ids: string[];
  /** Host operators (`x-flowline.operators` of the `op` field). */
  custom: RuleOperatorMeta[];
  /** Operator labels of the `op` field (`x-flowline.enumLabels`). */
  labels: Record<string, string>;
  /** Built-in and host operators without a right-hand value. */
  unary: Set<string>;
}

/** The operators the rule schema allows (falls back to every built-in operator). */
function schemaOps(root: JSONSchema, schema: JSONSchema): OperatorSet {
  const rulesProp = deref(root, (schema.properties as Record<string, unknown> | undefined)?.rules);
  const items = deref(root, rulesProp.items);
  const candidates = unionMembers(root, items) ?? [items];
  for (const m of candidates) {
    const op = deref(root, (m.properties as Record<string, unknown> | undefined)?.op);
    if (!Array.isArray(op.enum)) continue;
    const ids = op.enum.filter((x): x is string => typeof x === "string");
    const meta = metaOf(op);
    const custom = (meta.operators ?? []).filter((o) => ids.includes(o.id));
    const unary = new Set([
      ...UNARY,
      ...custom.filter((o) => o.arity === "unary").map((o) => o.id),
    ]);
    return { ids, custom, labels: meta.enumLabels ?? {}, unary };
  }
  return { ids: ALL_OPS, custom: [], labels: {}, unary: UNARY };
}

/** The operators offered for a `type` left value: built-in ones, then host ones for that type. */
function opsFor(type: ValueType, ops: OperatorSet): string[] {
  const builtin = OPS_BY_TYPE[type].filter((o) => ops.ids.includes(o));
  const custom = ops.custom.filter((o) => !o.types || o.types.includes(type)).map((o) => o.id);
  return [...builtin, ...custom];
}

/**
 * A right-hand value re-typed for a change of operator: entering "is one of" turns a literal
 * into a list (`5` → `[5]`), leaving it turns a list back into text. Other values stay.
 */
function retype(v: ValueExpr, list: boolean, type: ValueType): ValueExpr {
  if (list === Array.isArray(v) || isRef(v) || isTpl(v)) return v;
  const text = literalText(v);
  if (text === undefined) return v;
  return list ? toTypedList(text, type) : toTypedLiteral(text, type);
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * @internal A literal typed like the value it's compared with (spec §6.5): a true/false choice
 * for `boolean` (with the `{x}` toggle for a reference), else text with reference pills that
 * stores numbers for `number` (`"5"` → `5`, other text stays text) and, with `list`, a list of
 * such literals from comma-separated text (`"5, 7"` → `[5, 7]`).
 */
export function TypedValueInput({
  value,
  onChange,
  type,
  list = false,
  ariaLabel,
  placeholder,
}: {
  value: ValueExpr | undefined;
  onChange(v: ValueExpr): void;
  type: ValueType;
  list?: boolean;
  ariaLabel: string;
  placeholder?: string;
}): JSX.Element {
  const env = useFormEnv();
  const { labels } = useFlowlineAppearance();
  const id = useId();
  const choice = type === "boolean" && !list;
  const mode = useRefMode(value, (v) => onChange(v ?? ""), choice && !env.readOnly);
  /** The text as typed while it maps to the stored literal ("5.0" stays "5.0", not "5"). */
  const [draft, setDraft] = useState<string | null>(null);
  const toLiteral = (t: string): ValueExpr =>
    list ? toTypedList(t, type) : toTypedLiteral(t, type);
  const text = (
    <RefTextInput
      value={
        draft !== null && sameValue(toLiteral(draft), value) ? draft : (literalText(value) ?? value)
      }
      onChange={(v) => {
        if (typeof v === "string") {
          setDraft(v);
          onChange(toLiteral(v));
        } else {
          setDraft(null);
          onChange(v ?? "");
        }
      }}
      scope={env.scope}
      samples={env.samples}
      invalidRefs={env.invalidRefs}
      {...(placeholder === undefined ? {} : { placeholder })}
      ariaLabel={ariaLabel}
      readOnly={env.readOnly}
      {...(choice ? { singlePill: true } : {})}
    />
  );
  const items = list && Array.isArray(value) ? value : [];
  if (!list && !choice) return text;
  if (list) {
    // The same tree with or without tags, so the editor keeps focus as the first item appears.
    return (
      <div className="fl-typed">
        {text}
        {items.length > 0 && (
          // The typed items, as stored (numbers apart from text); the text above says the same.
          <ul className="fl-typed__tags" aria-hidden>
            {items.map((item, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: items can repeat; the list is re-derived from text.
                key={i}
                className="fl-typed__tag"
                data-type={typeof item}
              >
                {literalText(item) ?? JSON.stringify(item)}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  const current = typeof value === "boolean" || value === "true" || value === "false";
  return (
    <div className="fl-typed fl-typed--choice">
      {mode.on ? (
        text
      ) : (
        <select
          id={id}
          className="fl-input fl-select"
          aria-label={ariaLabel}
          value={current ? String(value) : ""}
          disabled={env.readOnly}
          onChange={(e) => onChange(e.target.value === "" ? "" : e.target.value === "true")}
        >
          {!current && <option value="">{labels.chooseOption}</option>}
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      )}
      <RefToggle on={mode.on} onToggle={mode.toggle} disabled={env.readOnly} />
    </div>
  );
}

const NEW_RULE: Rule = { left: "", op: "eq", right: "" };

/** One comparison row. */
function RuleRow({
  rule,
  index,
  count,
  path,
  ops,
  compare,
  join,
  within,
  onChange,
  onMove,
  onRemove,
}: {
  rule: Rule;
  index: number;
  count: number;
  path: string;
  ops: OperatorSet;
  compare: CompareMode;
  join?: string;
  /** The enclosing group's name, for rules inside a nested group ("Group 1, Value 2"). */
  within?: string;
  onChange(r: Rule): void;
  onMove(to: number): void;
  onRemove(): void;
}): JSX.Element {
  const env = useFormEnv();
  const { labels } = useFlowlineAppearance();
  const type = valueTypeOf(rule.left, env.scope);
  const allowed = opsFor(type, ops);
  const offered = allowed.includes(rule.op) ? allowed : [rule.op, ...allowed];
  const opName = (op: string) =>
    (type === "date" ? labels.ruleOpsDate[op] : undefined) ??
    labels.ruleOps[op] ??
    ops.labels[op] ??
    op;
  const unary = ops.unary.has(rule.op);
  const caseable =
    compare !== "strict" && TEXT_OPS.has(rule.op) && (type === "string" || type === "any");
  const base = labels.itemTitle(labels.ruleLeft, index + 1);
  const name = within ? `${within}, ${base}` : base;
  const setOp = (op: string) => {
    const { right: _r, caseSensitive: _c, ...rest } = rule;
    const next: Rule = { ...rest, op };
    if (!ops.unary.has(op)) next.right = retype(rule.right ?? "", op === "in", type);
    if (TEXT_OPS.has(op) && rule.caseSensitive) next.caseSensitive = true;
    onChange(next);
  };
  const literal = unary
    ? undefined
    : literalTypeIssue(rule, type, compare, labels.literalTypeWarning);
  const issues = issuesUnder(env.issues, path);
  return (
    <li className="fl-rule">
      {join && <span className="fl-rule__join">{join}</span>}
      <div className="fl-rule__card">
        <div className="fl-rule__fields">
          <RefTextInput
            value={rule.left}
            onChange={(v) => onChange({ ...rule, left: v ?? "" })}
            scope={env.scope}
            samples={env.samples}
            invalidRefs={env.invalidRefs}
            placeholder={labels.ruleLeft}
            ariaLabel={`${name}: ${labels.ruleLeft}`}
            readOnly={env.readOnly}
          />
          <div className="fl-rule__opline">
            <select
              className="fl-input fl-select fl-rule__op"
              aria-label={`${name}: ${labels.ruleOperator}`}
              value={rule.op}
              disabled={env.readOnly}
              onChange={(e) => setOp(e.target.value)}
            >
              {offered.map((op) => (
                <option key={op} value={op}>
                  {opName(op)}
                </option>
              ))}
            </select>
            {caseable && (
              <button
                type="button"
                className="fl-mini-btn fl-rule__case"
                aria-pressed={rule.caseSensitive === true}
                aria-label={`${name}: ${labels.matchCase}`}
                title={labels.matchCase}
                disabled={env.readOnly}
                onClick={() => {
                  const { caseSensitive: _c, ...rest } = rule;
                  onChange(rule.caseSensitive ? rest : { ...rest, caseSensitive: true });
                }}
              >
                <CaseSensitive size={15} aria-hidden />
              </button>
            )}
          </div>
          {!unary && (
            <TypedValueInput
              value={rule.right}
              onChange={(v) => onChange({ ...rule, right: v })}
              type={type}
              list={rule.op === "in"}
              placeholder={
                rule.op === "in"
                  ? labels.ruleListPlaceholder
                  : type === "date"
                    ? "2026-01-31T09:00:00Z"
                    : labels.ruleRight
              }
              ariaLabel={`${name}: ${labels.ruleRight}`}
            />
          )}
        </div>
        <ItemActions
          index={index}
          count={count}
          name={name}
          onMove={onMove}
          onRemove={onRemove}
          disabled={env.readOnly}
        />
      </div>
      <IssueNotes issues={literal ? [...issues, { ...literal, field: `${path}.right` }] : issues} />
    </li>
  );
}

/** The compare-mode choice (strict or loose) of the top-level group, with a one-line hint. */
function CompareSelect({
  value,
  label,
  onChange,
}: {
  value: CompareMode;
  /** Accessible name. */
  label: string;
  onChange(v: CompareMode): void;
}): JSX.Element {
  const env = useFormEnv();
  const { labels } = useFlowlineAppearance();
  const id = useId();
  return (
    <div className="fl-compare">
      <div className="fl-compare__row">
        <span className="fl-compare__label" aria-hidden>
          {labels.compare}
        </span>
        <select
          className="fl-input fl-select fl-compare__select"
          aria-label={label}
          aria-describedby={`${id}hint`}
          value={value}
          disabled={env.readOnly}
          onChange={(e) => onChange(e.target.value === "strict" ? "strict" : "loose")}
        >
          <option value="strict">{labels.compareStrict}</option>
          <option value="loose">{labels.compareLoose}</option>
        </select>
      </div>
      <p id={`${id}hint`} className="fl-f__help fl-compare__hint">
        {value === "strict" ? labels.compareStrictHint : labels.compareLooseHint}
      </p>
    </div>
  );
}

/** A rule group: the combinator choice, its rules and nested groups, and add buttons. */
function GroupEditor({
  group,
  path,
  ops,
  compare,
  nested,
  label,
  onChange,
}: {
  group: Group;
  path: string;
  ops: OperatorSet;
  /** The compare mode in effect (the top-level group's, else the schema default). */
  compare: CompareMode;
  nested: boolean;
  label: string;
  onChange(g: Group): void;
}): JSX.Element {
  const env = useFormEnv();
  const { labels } = useFlowlineAppearance();
  const keys = useItemKeys(group.rules.length);
  const setRules = (rules: (Rule | Group)[]) => onChange({ ...group, rules });
  const move = (from: number, to: number) => {
    keys.move(from, to);
    const next = [...group.rules];
    const [r] = next.splice(from, 1);
    if (r) next.splice(to, 0, r);
    setRules(next);
  };
  const remove = (i: number) => {
    keys.remove(i);
    setRules(group.rules.filter((_, j) => j !== i));
  };
  const join = labels.rulesJoin[group.combinator];
  return (
    <div className="fl-rules" data-nested={nested ? "" : undefined}>
      <div className="fl-rules__head">
        <span className="fl-rules__match">{labels.rulesMatch}</span>
        <Segmented<Combinator>
          label={`${label}: ${labels.rulesMatch}`}
          options={[
            { value: "and", label: labels.rulesCombinator.and },
            { value: "or", label: labels.rulesCombinator.or },
          ]}
          value={group.combinator}
          disabled={env.readOnly}
          onChange={(combinator) => onChange({ ...group, combinator })}
        />
      </div>
      {!nested && (
        <CompareSelect
          value={compare}
          label={`${label}: ${labels.compare}`}
          onChange={(mode) =>
            // Strict always matches case, so the Match case flags would only linger unused.
            onChange({ ...(mode === "strict" ? withoutMatchCase(group) : group), compare: mode })
          }
        />
      )}
      {group.rules.length === 0 ? (
        !nested && <p className="fl-empty-note">{labels.emptyRules}</p>
      ) : (
        <ol className="fl-rules__list">
          {group.rules.map((r, i) => {
            const rulePath = `${path}.rules[${i}]`;
            const k = keys.keys[i];
            if (isGroup(r)) {
              const own = labels.itemTitle(labels.ruleGroup, i + 1);
              const name = nested ? `${label}, ${own}` : own;
              return (
                <li key={k} className="fl-rule fl-rule--group">
                  {i > 0 && <span className="fl-rule__join">{join}</span>}
                  <div className="fl-rule__card fl-rule__card--group">
                    <GroupEditor
                      group={asGroup(r as unknown as ValueExpr)}
                      path={rulePath}
                      ops={ops}
                      compare={compare}
                      nested
                      label={name}
                      onChange={(g) => setRules(group.rules.map((x, j) => (j === i ? g : x)))}
                    />
                    <ItemActions
                      index={i}
                      count={group.rules.length}
                      name={name}
                      onMove={(to) => move(i, to)}
                      onRemove={() => remove(i)}
                      disabled={env.readOnly}
                    />
                  </div>
                  <IssueNotes issues={issuesAt(env.issues, rulePath)} />
                </li>
              );
            }
            return (
              <RuleRow
                key={k}
                rule={r as Rule}
                index={i}
                count={group.rules.length}
                path={rulePath}
                ops={ops}
                compare={compare}
                {...(i > 0 ? { join } : {})}
                {...(nested ? { within: label } : {})}
                onChange={(nr) => setRules(group.rules.map((x, j) => (j === i ? nr : x)))}
                onMove={(to) => move(i, to)}
                onRemove={() => remove(i)}
              />
            );
          })}
        </ol>
      )}
      <div className="fl-rules__add">
        <button
          type="button"
          className="fl-add-btn"
          disabled={env.readOnly}
          onClick={() => setRules([...group.rules, { ...NEW_RULE }])}
        >
          <Plus size={14} aria-hidden />
          {labels.addRule}
        </button>
        {!nested && (
          <button
            type="button"
            className="fl-add-btn"
            disabled={env.readOnly}
            onClick={() =>
              setRules([
                ...group.rules,
                { combinator: group.combinator === "and" ? "or" : "and", rules: [{ ...NEW_RULE }] },
              ])
            }
          >
            <ListPlus size={14} aria-hidden />
            {labels.addGroup}
          </button>
        )}
      </div>
    </div>
  );
}

/** The `"rules"` widget. */
export function RulesWidget(p: FieldProps): JSX.Element {
  const env = useFormEnv();
  const ops = schemaOps(env.root, p.schema);
  const group = asGroup(p.value);
  return (
    <FieldShell
      label={p.label}
      required={p.required}
      description={p.schema.description as string | undefined}
      issues={issuesAt(env.issues, p.path)
        .concat(issuesAt(env.issues, `${p.path}.rules`))
        .concat(issuesAt(env.issues, `${p.path}.compare`))}
      group
      bare={p.bare}
    >
      <GroupEditor
        group={group}
        path={p.path}
        ops={ops}
        compare={group.compare ?? compareDefault(env.root, p.schema)}
        nested={false}
        label={p.label}
        onChange={(g) => p.onChange(g as unknown as ValueExpr)}
      />
    </FieldShell>
  );
}
