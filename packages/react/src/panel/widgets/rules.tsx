/**
 * The `"rules"` widget: a condition builder for a rule group
 * (`{ combinator: "and" | "or", rules: (Rule | RuleGroup)[] }`, rules `{ left, op, right?,
 * caseSensitive? }`). Operators are filtered by the type of the left value; unary operators hide
 * the right value. Groups nest one level.
 *
 * @module
 */
import { isRef, isTpl, type JSONSchema, type ScopeEntry, type ValueExpr } from "@flowlinejs/core";
import { CaseSensitive, ListPlus, Plus } from "lucide-react";
import type { JSX } from "react";
import { useFlowlineAppearance } from "../../provider";
import { ItemActions, useItemKeys } from "../fields/collections";
import { FieldShell, IssueNotes, Segmented } from "../fields/shell";
import { type FieldProps, useFormEnv } from "../form-context";
import { RefTextInput } from "../ref-text-input";
import { deref, isAny, issuesAt, issuesUnder, refSchema, typesOf, unionMembers } from "../schema";
import { asObject } from "../schema-form";

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
export type ValueType = "string" | "date" | "number" | "boolean" | "array" | "object" | "any";

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

function isGroup(v: unknown): v is Group {
  const o = asObject(v as ValueExpr);
  return o !== undefined && Array.isArray(o.rules);
}

function asGroup(v: ValueExpr | undefined): Group {
  const o = asObject(v);
  const combinator = o?.combinator === "or" ? "or" : "and";
  const rules = Array.isArray(o?.rules) ? (o.rules as unknown as (Rule | Group)[]) : [];
  return { combinator, rules };
}

/** The operators the rule schema allows, in schema order (falls back to every operator). */
function schemaOps(root: JSONSchema, schema: JSONSchema): string[] {
  const rulesProp = deref(root, (schema.properties as Record<string, unknown> | undefined)?.rules);
  const items = deref(root, rulesProp.items);
  const candidates = unionMembers(root, items) ?? [items];
  for (const m of candidates) {
    const op = deref(root, (m.properties as Record<string, unknown> | undefined)?.op);
    if (Array.isArray(op.enum)) return op.enum.filter((x): x is string => typeof x === "string");
  }
  return ALL_OPS;
}

const NEW_RULE: Rule = { left: "", op: "eq", right: "" };

/** One comparison row. */
function RuleRow({
  rule,
  index,
  count,
  path,
  ops,
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
  ops: string[];
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
  const allowed = OPS_BY_TYPE[type].filter((o) => ops.includes(o));
  const offered = allowed.includes(rule.op) ? allowed : [rule.op, ...allowed];
  const opName = (op: string) =>
    (type === "date" ? labels.ruleOpsDate[op] : undefined) ?? labels.ruleOps[op] ?? op;
  const unary = UNARY.has(rule.op);
  const caseable = TEXT_OPS.has(rule.op) && (type === "string" || type === "any");
  const base = labels.itemTitle(labels.ruleLeft, index + 1);
  const name = within ? `${within}, ${base}` : base;
  const setOp = (op: string) => {
    const { right: _r, caseSensitive: _c, ...rest } = rule;
    const next: Rule = { ...rest, op };
    if (!UNARY.has(op)) next.right = rule.right ?? "";
    if (TEXT_OPS.has(op) && rule.caseSensitive) next.caseSensitive = true;
    onChange(next);
  };
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
            <RefTextInput
              value={rule.right}
              onChange={(v) => onChange({ ...rule, right: v ?? "" })}
              scope={env.scope}
              samples={env.samples}
              invalidRefs={env.invalidRefs}
              placeholder={
                rule.op === "in"
                  ? labels.ruleListPlaceholder
                  : type === "date"
                    ? "2026-01-31T09:00:00Z"
                    : labels.ruleRight
              }
              ariaLabel={`${name}: ${labels.ruleRight}`}
              readOnly={env.readOnly}
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
      <IssueNotes issues={issuesUnder(env.issues, path)} />
    </li>
  );
}

/** A rule group: the combinator choice, its rules and nested groups, and add buttons. */
function GroupEditor({
  group,
  path,
  ops,
  nested,
  label,
  onChange,
}: {
  group: Group;
  path: string;
  ops: string[];
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
  return (
    <FieldShell
      label={p.label}
      required={p.required}
      description={p.schema.description as string | undefined}
      issues={issuesAt(env.issues, p.path).concat(issuesAt(env.issues, `${p.path}.rules`))}
      group
      bare={p.bare}
    >
      <GroupEditor
        group={asGroup(p.value)}
        path={p.path}
        ops={ops}
        nested={false}
        label={p.label}
        onChange={(g) => p.onChange(g as unknown as ValueExpr)}
      />
    </FieldShell>
  );
}
