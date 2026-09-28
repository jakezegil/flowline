import type { FieldDecl } from "@flowlinejs/core";
import { type JSX, useId, useState } from "react";
import { useFlowlineAppearance } from "../provider";
import { SmallDialog } from "../ui/primitives";

/** The manual trigger's declared input fields (its `fields` config), ignoring malformed entries. */
export function manualFields(config: Record<string, unknown>): FieldDecl[] {
  const fields = config.fields;
  if (!Array.isArray(fields)) return [];
  return fields.filter(
    (f): f is FieldDecl =>
      f !== null && typeof f === "object" && typeof (f as FieldDecl).name === "string",
  );
}

type Draft = Record<string, string | boolean>;

/** Parses the dialog's values into the run input. Returns field errors instead when invalid. */
function toInput(
  fields: FieldDecl[],
  draft: Draft,
  labels: { required: string; invalidJson: string; invalidNumber: string; invalidDate: string },
): { input: Record<string, unknown> } | { errors: Record<string, string> } {
  const input: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const raw = draft[f.name];
    if (f.type === "boolean") {
      input[f.name] = raw === true;
      continue;
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text === "") {
      if (f.required) errors[f.name] = labels.required;
      continue;
    }
    if (f.type === "number") {
      const n = Number(text);
      if (Number.isFinite(n)) input[f.name] = n;
      else errors[f.name] = labels.invalidNumber;
    } else if (f.type === "object" || f.type === "array") {
      try {
        input[f.name] = JSON.parse(text);
      } catch {
        errors[f.name] = labels.invalidJson;
      }
    } else if (f.type === "date") {
      const d = new Date(text);
      if (Number.isNaN(d.getTime())) errors[f.name] = labels.invalidDate;
      else input[f.name] = d.toISOString();
    } else {
      input[f.name] = text;
    }
  }
  return Object.keys(errors).length > 0 ? { errors } : { input };
}

/** The "Run workflow" dialog: one control per manual-trigger field. */
export function RunDialog({
  open,
  onOpenChange,
  fields,
  version,
  dirty,
  busy,
  onRun,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  fields: FieldDecl[];
  version: number;
  /** Whether the draft has changes the published version lacks. */
  dirty: boolean;
  busy: boolean;
  onRun(input: Record<string, unknown>): void;
}): JSX.Element {
  const { labels } = useFlowlineAppearance();
  const [draft, setDraft] = useState<Draft>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const id = useId();
  const submit = () => {
    const result = toInput(fields, draft, labels);
    if ("errors" in result) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    onRun(result.input);
  };
  return (
    <SmallDialog
      open={open}
      onOpenChange={onOpenChange}
      title={labels.runDialogTitle}
      description={
        <>
          {labels.runDialogDescription(version)}
          {dirty && <> {labels.runDraftNote}</>}
        </>
      }
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="fl-btn" onClick={() => onOpenChange(false)}>
            {labels.cancel}
          </button>
          <button type="submit" className="fl-btn fl-btn--primary" disabled={busy}>
            {labels.startRun}
          </button>
        </>
      }
    >
      {fields.map((f) => {
        const fid = `${id}-${f.name}`;
        const err = errors[f.name];
        const errId = `${fid}-err`;
        const value = draft[f.name];
        const set = (v: string | boolean) => setDraft((d) => ({ ...d, [f.name]: v }));
        const common = {
          id: fid,
          "aria-invalid": err ? true : undefined,
          "aria-describedby": err ? errId : f.description ? `${fid}-desc` : undefined,
        };
        return (
          <div key={f.name} className="fl-field" data-kind={f.type}>
            {f.type === "boolean" ? (
              <label className="fl-check" htmlFor={fid}>
                <input
                  {...common}
                  type="checkbox"
                  checked={value === true}
                  onChange={(e) => set(e.target.checked)}
                />
                <span>{f.name}</span>
              </label>
            ) : (
              <>
                <label className="fl-field__label" htmlFor={fid}>
                  {f.name}
                  {f.required && <span className="fl-field__req">{labels.required}</span>}
                </label>
                {f.type === "object" || f.type === "array" ? (
                  <textarea
                    {...common}
                    className="fl-input fl-input--mono"
                    rows={3}
                    placeholder={
                      f.type === "array" ? labels.jsonListPlaceholder : labels.jsonPlaceholder
                    }
                    value={typeof value === "string" ? value : ""}
                    onChange={(e) => set(e.target.value)}
                  />
                ) : (
                  <input
                    {...common}
                    className="fl-input"
                    type={
                      f.type === "number" ? "number" : f.type === "date" ? "datetime-local" : "text"
                    }
                    value={typeof value === "string" ? value : ""}
                    onChange={(e) => set(e.target.value)}
                  />
                )}
              </>
            )}
            {f.description && !err && (
              <div id={`${fid}-desc`} className="fl-field__hint">
                {f.description}
              </div>
            )}
            {err && (
              <div id={errId} className="fl-field__error">
                {err}
              </div>
            )}
          </div>
        );
      })}
    </SmallDialog>
  );
}
