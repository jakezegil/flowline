/**
 * The `"fields"` widget: an editor of user-declared fields (`FieldDecl[]`: name, type, required,
 * description), e.g. a webhook's body fields or a manual trigger's inputs.
 *
 * @module
 */
import type { FieldType, ValueExpr } from "@flowline/core";
import { type JSX, useRef } from "react";
import { useFlowlineAppearance } from "../../provider";
import { AddButton, focusLastItem, ItemActions, useItemKeys } from "../fields/collections";
import { FieldShell, IssueNotes, Switch } from "../fields/shell";
import { type FieldProps, useFormEnv } from "../form-context";
import { issuesAt, issuesUnder } from "../schema";
import { asObject } from "../schema-form";

const TYPES: FieldType[] = ["string", "number", "boolean", "date", "object", "array"];
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Decl = Record<string, ValueExpr>;

/** The `"fields"` widget. */
export function FieldsWidget(p: FieldProps): JSX.Element {
  const env = useFormEnv();
  const { labels } = useFlowlineAppearance();
  const listRef = useRef<HTMLOListElement>(null);
  const decls: Decl[] = Array.isArray(p.value) ? p.value.map((d) => asObject(d) ?? {}) : [];
  const keys = useItemKeys(decls.length);
  const set = (next: Decl[]) => p.onChange(next);
  const update = (i: number, patch: Decl, drop?: string) =>
    set(
      decls.map((d, j) => {
        if (j !== i) return d;
        const next = { ...d, ...patch };
        if (drop) delete next[drop];
        return next;
      }),
    );
  const counts = new Map<string, number>();
  for (const d of decls) {
    const n = String(d.name ?? "");
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }

  return (
    <FieldShell
      label={p.label}
      required={p.required}
      description={p.schema.description as string | undefined}
      issues={issuesAt(env.issues, p.path)}
      group
      bare={p.bare}
    >
      {decls.length === 0 ? (
        <p className="fl-empty-note">{labels.emptyFields}</p>
      ) : (
        <ol ref={listRef} className="fl-list fl-decls">
          {decls.map((d, i) => {
            const nameText = typeof d.name === "string" ? d.name : "";
            const name = nameText || labels.itemTitle(labels.fieldName, i + 1);
            const badName = nameText !== "" && !IDENT.test(nameText);
            const dup = nameText !== "" && (counts.get(nameText) ?? 0) > 1;
            const type = typeof d.type === "string" ? d.type : "string";
            return (
              <li key={keys.keys[i]} className="fl-decl">
                <div className="fl-decl__main">
                  <input
                    className="fl-input fl-input--code fl-decl__name"
                    value={nameText}
                    placeholder={labels.fieldName}
                    aria-label={labels.itemTitle(labels.fieldName, i + 1)}
                    aria-invalid={badName || dup || undefined}
                    spellCheck={false}
                    autoCapitalize="off"
                    readOnly={env.readOnly}
                    onChange={(e) => update(i, { name: e.target.value })}
                  />
                  <select
                    className="fl-input fl-select fl-decl__type"
                    aria-label={`${name}: ${labels.fieldType}`}
                    value={type}
                    disabled={env.readOnly}
                    onChange={(e) => update(i, { type: e.target.value })}
                  >
                    {TYPES.map((t) => (
                      <option key={t} value={t}>
                        {labels.fieldTypes[t]}
                      </option>
                    ))}
                  </select>
                  <ItemActions
                    index={i}
                    count={decls.length}
                    name={name}
                    disabled={env.readOnly}
                    onMove={(to) => {
                      keys.move(i, to);
                      const next = [...decls];
                      const [x] = next.splice(i, 1);
                      if (x) next.splice(to, 0, x);
                      set(next);
                    }}
                    onRemove={() => {
                      keys.remove(i);
                      set(decls.filter((_, j) => j !== i));
                    }}
                  />
                </div>
                <div className="fl-decl__sub">
                  <input
                    className="fl-input fl-input--quiet"
                    value={typeof d.description === "string" ? d.description : ""}
                    placeholder={labels.fieldDescription}
                    aria-label={`${name}: ${labels.fieldDescription}`}
                    readOnly={env.readOnly}
                    onChange={(e) =>
                      e.target.value === ""
                        ? update(i, {}, "description")
                        : update(i, { description: e.target.value })
                    }
                  />
                  {/* biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is the control. */}
                  <label className="fl-decl__req">
                    <Switch
                      checked={d.required === true}
                      label={`${name}: ${labels.fieldRequired}`}
                      disabled={env.readOnly}
                      onChange={(v) =>
                        v ? update(i, { required: true }) : update(i, {}, "required")
                      }
                    />
                    <span aria-hidden>{labels.fieldRequired}</span>
                  </label>
                </div>
                {(badName || dup) && (
                  <p className="fl-f__local">
                    {badName ? labels.invalidFieldName : labels.duplicateField}
                  </p>
                )}
                <IssueNotes issues={issuesUnder(env.issues, `${p.path}[${i}]`)} />
              </li>
            );
          })}
        </ol>
      )}
      <AddButton
        label={labels.addField}
        disabled={env.readOnly}
        onClick={() => {
          set([...decls, { name: "", type: "string" }]);
          focusLastItem(listRef);
        }}
      />
    </FieldShell>
  );
}
