/**
 * The `"cases"` widget: switch cases as rows of name + matching value. A case's `id` (its path's
 * ID, used in step paths) is derived from its name while the case is new, and stays fixed once
 * the name field is left, so steps on that path stay attached when it's renamed later. Case
 * values are typed like the switch's `value` (`5`, not `"5"`, for a number), and flagged when
 * the switch's `compare` mode is strict and a value has another type.
 *
 * @module
 */
import type { JSONSchema, ValueExpr } from "@flowlinejs/core";
import { type JSX, useRef } from "react";
import { useFlowlineAppearance } from "../../provider";
import { AddButton, focusLastItem, ItemActions, useItemKeys } from "../fields/collections";
import { FieldShell, IssueNotes } from "../fields/shell";
import { type FieldProps, useFormEnv } from "../form-context";
import { issuesAt, issuesUnder, itemsOf } from "../schema";
import { asObject, ObjectFields, withKey } from "../schema-form";
import { literalTypeIssue } from "./literal";
import { asCompare, compareDefault, TypedValueInput, valueTypeOf } from "./rules";

/** Reserved for the switch's fallback path. */
const RESERVED = new Set(["default"]);

/** A path ID from a case name: `"Gold customers"` → `"gold_customers"`. */
export function slugify(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/** A slug of `label` not used by `taken` (or reserved): `gold`, `gold_2`, … */
export function uniqueSlug(label: string, taken: Set<string>): string {
  const base = slugify(label) || "case";
  let id = base;
  for (let n = 2; taken.has(id) || RESERVED.has(id); n++) id = `${base}_${n}`;
  return id;
}

type Case = Record<string, ValueExpr>;

/** The `"cases"` widget. */
export function CasesWidget(p: FieldProps): JSX.Element {
  const env = useFormEnv();
  const { labels } = useFlowlineAppearance();
  const listRef = useRef<HTMLOListElement>(null);
  const cases: Case[] = Array.isArray(p.value) ? p.value.map((c) => asObject(c) ?? {}) : [];
  const keys = useItemKeys(cases.length);
  /** IDs of cases created here whose name is still being typed: their ID follows the name. */
  const fresh = useRef(new Set<string>());
  const items = itemsOf(env.root, p.schema);
  // Cases compare with the switch's value (a sibling field) in the switch's compare mode.
  const type = valueTypeOf(env.values.value, env.scope);
  const compare = asCompare(env.values.compare) ?? compareDefault(env.root, env.root);
  const extra = Object.keys((items.properties ?? {}) as Record<string, JSONSchema>).filter(
    (k) => k !== "id" && k !== "label" && k !== "value",
  );

  const set = (next: Case[]) => p.onChange(next);
  const idsExcept = (i: number) =>
    new Set(cases.filter((_, j) => j !== i).map((c) => String(c.id ?? "")));

  const add = () => {
    const id = uniqueSlug("", idsExcept(-1));
    fresh.current.add(id);
    set([...cases, { id, label: "", value: "" }]);
    focusLastItem(listRef);
  };
  const rename = (i: number, label: string) => {
    const c = cases[i] as Case;
    const id = String(c.id ?? "");
    let nextId = id;
    if (fresh.current.has(id)) {
      fresh.current.delete(id);
      nextId = uniqueSlug(label, idsExcept(i));
      fresh.current.add(nextId);
    }
    set(cases.map((x, j) => (j === i ? { ...x, id: nextId, label } : x)));
  };

  return (
    <FieldShell
      label={p.label}
      required={p.required}
      description={p.schema.description as string | undefined}
      issues={issuesAt(env.issues, p.path)}
      group
      bare={p.bare}
    >
      {cases.length === 0 ? (
        <p className="fl-empty-note">{labels.emptyCases}</p>
      ) : (
        <ol ref={listRef} className="fl-list fl-cases">
          {cases.map((c, i) => {
            const path = `${p.path}[${i}]`;
            const id = String(c.id ?? "");
            const name =
              (typeof c.label === "string" && c.label) || labels.itemTitle(labels.caseLabel, i + 1);
            const literal = literalTypeIssue(
              { op: "eq", right: c.value },
              type,
              compare,
              labels.literalTypeWarning,
            );
            const issues = issuesUnder(env.issues, path);
            return (
              <li key={keys.keys[i]} className="fl-case">
                <div className="fl-case__card">
                  <div className="fl-case__fields">
                    <input
                      className="fl-input fl-case__label"
                      value={typeof c.label === "string" ? c.label : ""}
                      placeholder={labels.caseLabel}
                      aria-label={`${labels.itemTitle(labels.caseLabel, i + 1)}`}
                      readOnly={env.readOnly}
                      onChange={(e) => rename(i, e.target.value)}
                      onBlur={() => {
                        if ((c.label ?? "") !== "") fresh.current.delete(id);
                      }}
                    />
                    <TypedValueInput
                      value={c.value}
                      onChange={(v) =>
                        set(cases.map((x, j) => (j === i ? withKey(x, "value", v) : x)))
                      }
                      type={type}
                      placeholder={labels.caseValue}
                      ariaLabel={`${name}: ${labels.caseValue}`}
                    />
                    {extra.length > 0 && (
                      <ObjectFields
                        schema={{ ...items, properties: pick(items, extra) }}
                        path={path}
                        value={c}
                        onChange={(k, v) =>
                          set(cases.map((x, j) => (j === i ? withKey(x, k, v) : x)))
                        }
                      />
                    )}
                    <span className="fl-case__id">{labels.caseId(id)}</span>
                  </div>
                  <ItemActions
                    index={i}
                    count={cases.length}
                    name={name}
                    disabled={env.readOnly}
                    onMove={(to) => {
                      keys.move(i, to);
                      const next = [...cases];
                      const [x] = next.splice(i, 1);
                      if (x) next.splice(to, 0, x);
                      set(next);
                    }}
                    onRemove={() => {
                      keys.remove(i);
                      set(cases.filter((_, j) => j !== i));
                    }}
                  />
                </div>
                <IssueNotes
                  issues={literal ? [...issues, { ...literal, field: `${path}.value` }] : issues}
                />
              </li>
            );
          })}
        </ol>
      )}
      <AddButton label={labels.addCase} onClick={add} disabled={env.readOnly} />
    </FieldShell>
  );
}

function pick(schema: JSONSchema, keys: string[]): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  return Object.fromEntries(keys.map((k) => [k, props[k]]));
}
