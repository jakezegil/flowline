/**
 * Controls of structured fields: lists, objects (fieldsets), string maps and discriminated
 * unions.
 *
 * @module
 */
import type { JSONSchema, ValueExpr } from "@flowline/core";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { type JSX, useEffect, useId, useRef, useState } from "react";
import { useFlowlineAppearance } from "../../provider";
import { type FieldProps, fieldMetaOf, useFormEnv } from "../form-context";
import { RefTextInput } from "../ref-text-input";
import {
  discriminatedUnion,
  fieldKind,
  initialValue,
  issuesAt,
  itemPath,
  itemsOf,
  labelOf,
  mapValueOf,
} from "../schema";
import { asObject, Field, ObjectFields, withKey } from "../schema-form";
import { enumOptions, useRefMode } from "./controls";
import { FieldShell, IssueNotes, RefToggle, Segmented } from "./shell";

/**
 * Stable React keys for the items of a list that can be added to, removed from and reordered.
 * @internal
 */
export function useItemKeys(length: number): {
  keys: number[];
  remove(i: number): void;
  move(from: number, to: number): void;
} {
  const ref = useRef({ keys: [] as number[], next: 0 });
  const r = ref.current;
  while (r.keys.length < length) r.keys.push(r.next++);
  if (r.keys.length > length) r.keys.length = length;
  return {
    keys: r.keys,
    remove: (i) => {
      r.keys.splice(i, 1);
    },
    move: (from, to) => {
      const [k] = r.keys.splice(from, 1);
      if (k !== undefined) r.keys.splice(to, 0, k);
    },
  };
}

/** Focuses the first control of the last item of a list after it renders. */
export function focusLastItem(list: { current: HTMLElement | null }): void {
  requestAnimationFrame(() => {
    const items = list.current?.querySelectorAll<HTMLElement>(":scope > li");
    const last = items?.[items.length - 1];
    last
      ?.querySelector<HTMLElement>(
        'input, textarea, select, [contenteditable="true"], [role="switch"], [role="radio"][tabindex="0"]',
      )
      ?.focus();
  });
}

/** Up / down / remove buttons of a list item. */
export function ItemActions({
  index,
  count,
  name,
  onMove,
  onRemove,
  disabled,
}: {
  index: number;
  count: number;
  /** The item's name, for the buttons' accessible names. */
  name: string;
  onMove(to: number): void;
  onRemove(): void;
  disabled?: boolean;
}): JSX.Element {
  const { labels } = useFlowlineAppearance();
  return (
    <div className="fl-item__actions">
      {count > 1 && (
        <>
          <button
            type="button"
            className="fl-mini-btn"
            aria-label={`${labels.moveUp}: ${name}`}
            disabled={disabled || index === 0}
            onClick={() => onMove(index - 1)}
          >
            <ArrowUp size={13} aria-hidden />
          </button>
          <button
            type="button"
            className="fl-mini-btn"
            aria-label={`${labels.moveDown}: ${name}`}
            disabled={disabled || index === count - 1}
            onClick={() => onMove(index + 1)}
          >
            <ArrowDown size={13} aria-hidden />
          </button>
        </>
      )}
      <button
        type="button"
        className="fl-mini-btn fl-mini-btn--danger"
        aria-label={`${labels.remove}: ${name}`}
        disabled={disabled}
        onClick={onRemove}
      >
        <X size={13} aria-hidden />
      </button>
    </div>
  );
}

/** The "+ Add …" button under a list. */
export function AddButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick(): void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button type="button" className="fl-add-btn" onClick={onClick} disabled={disabled}>
      <Plus size={14} aria-hidden />
      {label}
    </button>
  );
}

/** A new item for a list of `items`. */
function newItem(root: JSONSchema, items: JSONSchema): ValueExpr {
  const initial = initialValue(root, items);
  if (initial !== undefined) return initial;
  switch (fieldKind(root, items)) {
    case "object":
    case "map":
      return {};
    case "number":
      return 0;
    case "boolean":
      return false;
    case "enum":
      return (enumOptions(items)[0] ?? "") as ValueExpr;
    case "array":
      return [];
    default:
      return "";
  }
}

/** A text label of a list item from its `label`/`name`/`title`, if it has one. */
function itemName(v: ValueExpr | undefined): string | undefined {
  if (typeof v === "string" && v.trim() !== "" && v.length <= 40) return v;
  const obj = asObject(v);
  for (const k of ["label", "name", "title"]) {
    const s = obj?.[k];
    if (typeof s === "string" && s.trim() !== "") return s;
  }
  return undefined;
}

/**
 * A list: object items as cards (fields inside), other items as rows. Items can be added,
 * removed and moved; the `{x}` toggle maps the whole list from a reference instead.
 */
export function ArrayField(p: FieldProps): JSX.Element {
  const env = useFormEnv();
  const { labels } = useFlowlineAppearance();
  const meta = fieldMetaOf(env, p.schema);
  const listRef = useRef<HTMLOListElement>(null);
  const items = itemsOf(env.root, p.schema);
  const objectItems = fieldKind(env.root, items) === "object";
  const refOnly = meta.refOnly === true;
  const mode = useRefMode(p.value, p.onChange, !meta.literalOnly && !refOnly);
  const list = Array.isArray(p.value) ? p.value : [];
  const keys = useItemKeys(list.length);
  const itemLabel = labelOf(items, "Item");
  const refMode = refOnly || mode.on;

  const set = (next: ValueExpr[]) => p.onChange(next);
  const add = () => {
    set([...list, newItem(env.root, items)]);
    focusLastItem(listRef);
  };
  const remove = (i: number) => {
    keys.remove(i);
    set(list.filter((_, j) => j !== i));
  };
  const move = (from: number, to: number) => {
    keys.move(from, to);
    const next = [...list];
    const [v] = next.splice(from, 1);
    next.splice(to, 0, v as ValueExpr);
    set(next);
  };

  return (
    <FieldShell
      label={p.label}
      required={p.required}
      description={p.schema.description as string | undefined}
      issues={issuesAt(env.issues, p.path)}
      aside={
        refOnly || meta.literalOnly ? undefined : (
          <RefToggle on={mode.on} onToggle={mode.toggle} disabled={env.readOnly} />
        )
      }
      group
      bare={p.bare}
    >
      {refMode ? (
        <RefTextInput
          value={p.value}
          onChange={p.onChange}
          scope={env.scope}
          samples={env.samples}
          invalidRefs={env.invalidRefs}
          ariaLabel={p.label}
          singlePill
          readOnly={env.readOnly}
          schema={p.schema}
        />
      ) : (
        <>
          {list.length > 0 && (
            <ol ref={listRef} className={objectItems ? "fl-list fl-list--cards" : "fl-list"}>
              {list.map((v, i) => {
                const name = itemName(v) ?? labels.itemTitle(itemLabel, i + 1);
                const actions = (
                  <ItemActions
                    index={i}
                    count={list.length}
                    name={name}
                    onMove={(to) => move(i, to)}
                    onRemove={() => remove(i)}
                    disabled={env.readOnly}
                  />
                );
                const path = itemPath(p.path, i);
                const onItem = (nv: ValueExpr | undefined) =>
                  set(list.map((x, j) => (j === i ? (nv ?? null) : x)));
                return (
                  <li key={keys.keys[i]} className={objectItems ? "fl-item" : "fl-row"}>
                    {objectItems ? (
                      <>
                        <div className="fl-item__head">
                          <span className="fl-item__title">{name}</span>
                          {actions}
                        </div>
                        <ObjectFields
                          schema={items}
                          path={path}
                          value={asObject(v)}
                          onChange={(k, nv) => onItem(withKey(asObject(v), k, nv))}
                        />
                      </>
                    ) : (
                      <>
                        <div className="fl-row__control">
                          <Field
                            schema={items}
                            fieldKey={String(i)}
                            path={path}
                            label={labels.itemTitle(p.label, i + 1)}
                            required
                            value={v}
                            onChange={onItem}
                            bare
                          />
                        </div>
                        {actions}
                      </>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          <AddButton label={labels.addItem} onClick={add} disabled={env.readOnly} />
        </>
      )}
    </FieldShell>
  );
}

/** An object with properties, as a nested fieldset. Emptied optional objects are removed. */
export function ObjectField(p: FieldProps): JSX.Element {
  const env = useFormEnv();
  const obj = asObject(p.value);
  return (
    <FieldShell
      label={p.label}
      required={p.required}
      description={p.schema.description as string | undefined}
      issues={issuesAt(env.issues, p.path)}
      group
      bare={p.bare}
    >
      <div className="fl-nest">
        <ObjectFields
          schema={p.schema}
          path={p.path}
          value={obj}
          onChange={(k, v) => {
            const next = withKey(obj, k, v);
            p.onChange(Object.keys(next).length === 0 && !p.required ? undefined : next);
          }}
        />
      </div>
    </FieldShell>
  );
}

interface MapRow {
  id: number;
  key: string;
  value: ValueExpr | undefined;
}

function rowsOf(obj: Record<string, ValueExpr> | undefined, nextId: () => number): MapRow[] {
  return Object.entries(obj ?? {}).map(([key, value]) => ({ id: nextId(), key, value }));
}

function objectOf(rows: MapRow[]): Record<string, ValueExpr> {
  const out: Record<string, ValueExpr> = {};
  for (const r of rows) {
    if (r.key !== "" && !(r.key in out)) out[r.key] = r.value ?? "";
  }
  return out;
}

/** String-keyed values (`additionalProperties`), e.g. headers: key / value rows. */
export function MapField(p: FieldProps): JSX.Element {
  const env = useFormEnv();
  const { labels } = useFlowlineAppearance();
  const meta = fieldMetaOf(env, p.schema);
  const listRef = useRef<HTMLOListElement>(null);
  const valueSchema = mapValueOf(env.root, p.schema);
  const textValues = ["string", "any"].includes(fieldKind(env.root, valueSchema));
  const refOnly = meta.refOnly === true;
  const mode = useRefMode(p.value, p.onChange, !meta.literalOnly && !refOnly);
  const refMode = refOnly || mode.on;
  const idRef = useRef(0);
  const nextId = () => idRef.current++;
  const obj = asObject(p.value);
  const [rows, setRows] = useState<MapRow[]>(() => rowsOf(obj, nextId));
  const keyId = useId();

  // An outside change (undo, another editor) replaces the rows.
  const incoming = JSON.stringify(obj ?? {});
  useEffect(() => {
    setRows((current) =>
      JSON.stringify(objectOf(current)) === incoming
        ? current
        : rowsOf(JSON.parse(incoming) as Record<string, ValueExpr>, () => idRef.current++),
    );
  }, [incoming]);

  const commit = (next: MapRow[]) => {
    setRows(next);
    const out = objectOf(next);
    p.onChange(Object.keys(out).length === 0 && !p.required ? undefined : out);
  };
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);

  return (
    <FieldShell
      label={p.label}
      required={p.required}
      description={p.schema.description as string | undefined}
      issues={issuesAt(env.issues, p.path)}
      aside={
        meta.literalOnly || refOnly ? undefined : (
          <RefToggle on={mode.on} onToggle={mode.toggle} disabled={env.readOnly} />
        )
      }
      group
      bare={p.bare}
    >
      {refMode ? (
        <RefTextInput
          value={p.value}
          onChange={p.onChange}
          scope={env.scope}
          samples={env.samples}
          invalidRefs={env.invalidRefs}
          ariaLabel={p.label}
          singlePill
          readOnly={env.readOnly}
          schema={p.schema}
        />
      ) : (
        <>
          {rows.length > 0 && (
            <ol ref={listRef} className="fl-list fl-kv">
              {rows.map((r, i) => {
                const dup = r.key !== "" && (counts.get(r.key) ?? 0) > 1;
                const name = r.key || labels.itemTitle(labels.mapKey, i + 1);
                return (
                  <li key={r.id} className="fl-kv__row">
                    <input
                      id={`${keyId}-${r.id}`}
                      className="fl-input fl-kv__key"
                      value={r.key}
                      placeholder={labels.mapKey}
                      aria-label={`${p.label}: ${labels.mapKey} ${i + 1}`}
                      aria-invalid={dup || undefined}
                      readOnly={env.readOnly}
                      spellCheck={false}
                      onChange={(e) =>
                        commit(rows.map((x) => (x.id === r.id ? { ...x, key: e.target.value } : x)))
                      }
                    />
                    <div className="fl-kv__value">
                      {textValues ? (
                        <RefTextInput
                          value={r.value}
                          onChange={(v) =>
                            commit(rows.map((x) => (x.id === r.id ? { ...x, value: v } : x)))
                          }
                          scope={env.scope}
                          samples={env.samples}
                          invalidRefs={env.invalidRefs}
                          placeholder={labels.mapValue}
                          ariaLabel={`${p.label}: ${r.key || labels.mapValue}`}
                          readOnly={env.readOnly}
                          schema={valueSchema}
                        />
                      ) : (
                        <Field
                          schema={valueSchema}
                          fieldKey={r.key}
                          path={`${p.path}.${r.key}`}
                          label={`${p.label}: ${r.key || labels.mapValue}`}
                          required
                          value={r.value}
                          onChange={(v) =>
                            commit(rows.map((x) => (x.id === r.id ? { ...x, value: v } : x)))
                          }
                          bare
                        />
                      )}
                    </div>
                    <button
                      type="button"
                      className="fl-mini-btn fl-mini-btn--danger"
                      aria-label={`${labels.remove}: ${name}`}
                      disabled={env.readOnly}
                      onClick={() => commit(rows.filter((x) => x.id !== r.id))}
                    >
                      <X size={13} aria-hidden />
                    </button>
                    {dup && <p className="fl-f__local fl-kv__error">{labels.duplicateKey}</p>}
                    {r.key !== "" && (
                      <div className="fl-kv__issues">
                        <IssueNotes issues={issuesAt(env.issues, `${p.path}.${r.key}`)} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          <AddButton
            label={labels.addEntry}
            disabled={env.readOnly}
            onClick={() => {
              setRows([...rows, { id: nextId(), key: "", value: undefined }]);
              focusLastItem(listRef);
            }}
          />
        </>
      )}
    </FieldShell>
  );
}

/**
 * A discriminated union (e.g. `auth: none | bearer | basic | header`): a choice of variant, then
 * that variant's fields. Switching variants keeps fields both variants have.
 */
export function UnionField(p: FieldProps): JSX.Element | null {
  const env = useFormEnv();
  const { labels } = useFlowlineAppearance();
  const id = useId();
  const union = discriminatedUnion(env.root, p.schema);
  const obj = asObject(p.value) ?? asObject(p.schema.default as ValueExpr | undefined);
  if (!union) return null;
  const current = obj?.[union.key];
  const variant = union.variants.find((v) => v.value === current);
  const choose = (value: string | number | boolean) => {
    const next = union.variants.find((v) => v.value === value);
    if (!next || next === variant) return;
    const base = asObject(initialValue(env.root, next.schema)) ?? {};
    const props = (next.schema.properties ?? {}) as Record<string, unknown>;
    const carried: Record<string, ValueExpr> = {};
    for (const [k, v] of Object.entries(obj ?? {})) if (k in props) carried[k] = v;
    p.onChange({ ...base, ...carried, [union.key]: value });
  };
  const options = union.variants.map((v) => ({ value: v.value, label: v.label }));
  const compact = options.length <= 4 && options.every((o) => o.label.length <= 10);
  return (
    <FieldShell
      label={p.label}
      required={p.required}
      description={p.schema.description as string | undefined}
      issues={issuesAt(env.issues, p.path).concat(issuesAt(env.issues, `${p.path}.${union.key}`))}
      htmlFor={compact ? undefined : id}
      group={compact}
      bare={p.bare}
    >
      {compact ? (
        <Segmented
          label={p.label}
          options={options}
          value={current as string | number | boolean | undefined}
          disabled={env.readOnly}
          onChange={choose}
        />
      ) : (
        <select
          id={id}
          className="fl-input fl-select"
          value={variant ? String(union.variants.indexOf(variant)) : ""}
          disabled={env.readOnly}
          onChange={(e) => {
            const v = union.variants[Number(e.target.value)];
            if (v) choose(v.value);
          }}
        >
          {!variant && <option value="">{labels.chooseOption}</option>}
          {union.variants.map((v, i) => (
            <option key={String(v.value)} value={String(i)}>
              {v.label}
            </option>
          ))}
        </select>
      )}
      {variant && Object.keys(variant.schema.properties ?? {}).length > 1 && (
        <div className="fl-nest fl-nest--variant">
          <ObjectFields
            schema={variant.schema}
            path={p.path}
            value={obj}
            exclude={[union.key]}
            onChange={(k, v) => p.onChange({ ...withKey(obj, k, v), [union.key]: variant.value })}
          />
        </div>
      )}
    </FieldShell>
  );
}
