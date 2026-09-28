/**
 * Controls of single-value fields: text (with pills), number, boolean, choice and free-form
 * ("any") values. Number, boolean and choice fields toggle into reference mode with `{x}`.
 *
 * @module
 */
import { isRef, isTpl, type JSONSchema, type ValueExpr } from "@flowkit/core";
import { Braces } from "lucide-react";
import { type JSX, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useFlowkitAppearance } from "../../provider";
import { type FieldProps, fieldMetaOf, useFormEnv } from "../form-context";
import { RefTextInput } from "../ref-text-input";
import { metaOf, optionLabel } from "../schema";
import { AsideToggle, FieldShell, RefToggle, Segmented, Switch } from "./shell";

/** Whether a value is a reference or template rather than a literal. */
export function isExpr(v: unknown): boolean {
  return isRef(v) || isTpl(v);
}

/** Placeholder text of a field: its hint, else its default, else a format example. */
export function placeholderOf(schema: JSONSchema): string | undefined {
  const meta = metaOf(schema);
  if (typeof meta.placeholder === "string") return meta.placeholder;
  const d = schema.default;
  if (typeof d === "string" || typeof d === "number") return String(d);
  if (schema.format === "date-time") return "2026-01-31T09:00:00Z";
  if (schema.format === "email") return "name@example.com";
  if (schema.format === "uri") return "https://";
  return undefined;
}

/**
 * Reference mode of a literal-typed field. Entering it sets a literal value aside (and clears
 * the field); leaving it clears the reference and brings the literal back.
 */
export function useRefMode(
  value: ValueExpr | undefined,
  onChange: (v: ValueExpr | undefined) => void,
  allowed: boolean,
): { on: boolean; toggle(): void } {
  const expr = isExpr(value);
  const [on, setOn] = useState(expr);
  const stash = useRef<ValueExpr | undefined>(undefined);
  useEffect(() => {
    if (expr) setOn(true);
  }, [expr]);
  const active = allowed && (on || expr);
  return {
    on: active,
    toggle() {
      if (active) {
        onChange(stash.current);
        stash.current = undefined;
        setOn(false);
      } else {
        stash.current = value;
        if (value !== undefined) onChange(undefined);
        setOn(true);
      }
    },
  };
}

/** A single-pill reference input standing in for a literal control. */
function RefInput({ p }: { p: FieldProps }): JSX.Element {
  const env = useFormEnv();
  return (
    <RefTextInput
      value={p.value}
      onChange={p.onChange}
      scope={env.scope}
      samples={env.samples}
      invalidRefs={env.invalidRefs}
      ariaLabel={p.label}
      singlePill
      readOnly={env.readOnly}
    />
  );
}

/** Frame of a literal field with the `{x}` toggle (unless `literalOnly` or `refOnly`). */
function LiteralField({
  p,
  htmlFor,
  inline,
  children,
}: {
  p: FieldProps;
  htmlFor?: string;
  inline?: boolean;
  children: ReactNode;
}): JSX.Element {
  const env = useFormEnv();
  const meta = fieldMetaOf(env, p.schema);
  const refOnly = meta.refOnly === true;
  const mode = useRefMode(p.value, p.onChange, !meta.literalOnly && !refOnly);
  const refMode = refOnly || mode.on;
  const toggle =
    meta.literalOnly || refOnly ? undefined : (
      <RefToggle on={mode.on} onToggle={mode.toggle} disabled={env.readOnly} />
    );
  return (
    <FieldShell
      label={p.label}
      required={p.required}
      description={p.schema.description as string | undefined}
      issues={env.issues.filter((i) => i.field === p.path)}
      {...(refMode ? {} : htmlFor ? { htmlFor } : {})}
      aside={toggle}
      inline={inline && !refMode}
      bare={p.bare}
    >
      {refMode ? <RefInput p={p} /> : children}
    </FieldShell>
  );
}

/** Text with inline pills. */
export function StringField(p: FieldProps): JSX.Element {
  const env = useFormEnv();
  const meta = fieldMetaOf(env, p.schema);
  return (
    <FieldShell
      label={p.label}
      required={p.required}
      description={p.schema.description as string | undefined}
      issues={env.issues.filter((i) => i.field === p.path)}
      bare={p.bare}
    >
      <RefTextInput
        value={p.value}
        onChange={p.onChange}
        scope={env.scope}
        samples={env.samples}
        multiline={meta.multiline === true || meta.widget === "textarea"}
        {...optional("placeholder", placeholderOf(p.schema))}
        invalidRefs={env.invalidRefs}
        ariaLabel={p.label}
        singlePill={meta.refOnly === true}
        literalOnly={meta.literalOnly === true}
        readOnly={env.readOnly}
      />
    </FieldShell>
  );
}

function optional<K extends string, V>(key: K, v: V | undefined): { [P in K]?: V } {
  return (v === undefined ? {} : { [key]: v }) as { [P in K]?: V };
}

function parseNumber(text: string, integer: boolean): number | undefined {
  const t = text.trim().replace(/_/g, "");
  if (t === "" || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) return undefined;
  return n;
}

/** A number, as text so partial input ("-", "1.") can be typed. */
export function NumberField(p: FieldProps): JSX.Element {
  const env = useFormEnv();
  const { labels } = useFlowkitAppearance();
  const id = useId();
  const integer = p.schema.type === "integer";
  const text = typeof p.value === "number" ? String(p.value) : "";
  const [draft, setDraft] = useState<string | null>(null);
  const parsed = draft === null ? undefined : parseNumber(draft, integer);
  const bad = draft !== null && draft.trim() !== "" && parsed === undefined;
  // A draft only wins while it is mid-typing or still matches the value (not after an undo).
  const shown = draft !== null && (bad || parsed === p.value) ? draft : text;
  return (
    <LiteralField p={p} htmlFor={id}>
      <input
        id={id}
        className="fk-input fk-input--num"
        type="text"
        inputMode={integer ? "numeric" : "decimal"}
        value={shown}
        {...optional("placeholder", placeholderOf(p.schema))}
        aria-invalid={bad || undefined}
        aria-label={p.bare ? p.label : undefined}
        readOnly={env.readOnly}
        onChange={(e) => {
          const t = e.target.value;
          setDraft(t);
          if (t.trim() === "") p.onChange(undefined);
          else {
            const n = parseNumber(t, integer);
            if (n !== undefined) p.onChange(n);
          }
        }}
        onBlur={() => {
          if (!bad) setDraft(null);
        }}
      />
      {bad && <p className="fk-f__local">{labels.invalidNumber}</p>}
    </LiteralField>
  );
}

/** A switch, on the label row. */
export function BooleanField(p: FieldProps): JSX.Element {
  const env = useFormEnv();
  const id = useId();
  const checked =
    typeof p.value === "boolean"
      ? p.value
      : typeof p.schema.default === "boolean" && p.schema.default;
  return (
    <LiteralField p={p} htmlFor={id} inline>
      <Switch
        id={id}
        checked={checked}
        label={p.label}
        disabled={env.readOnly}
        onChange={(v) => p.onChange(v)}
      />
    </LiteralField>
  );
}

/** Enum values of a schema (`enum` or `const`). */
export function enumOptions(schema: JSONSchema): unknown[] {
  if (Array.isArray(schema.enum)) return schema.enum;
  if ("const" in schema) return [schema.const];
  return [];
}

/**
 * A choice: a segmented control for up to four short options that always has a value, else a
 * select (with an empty option when the field is optional and has no default).
 */
export function EnumField(p: FieldProps): JSX.Element {
  const env = useFormEnv();
  const { labels } = useFlowkitAppearance();
  const id = useId();
  const values = enumOptions(p.schema);
  const meta = fieldMetaOf(env, p.schema);
  const options = values.map((v) => ({ value: v, label: optionLabel(v, meta) }));
  const current = p.value !== undefined ? p.value : (p.schema.default as ValueExpr | undefined);
  const always = p.required || p.schema.default !== undefined;
  const compact =
    always &&
    options.length <= 4 &&
    options.every((o) => o.label.length <= 12) &&
    values.every((v) => typeof v === "string");
  if (compact) {
    return (
      <LiteralField p={p}>
        <Segmented
          label={p.label}
          options={options as { value: string; label: string }[]}
          value={current as string | undefined}
          disabled={env.readOnly}
          onChange={(v) => p.onChange(v)}
        />
      </LiteralField>
    );
  }
  const index = values.findIndex((v) => JSON.stringify(v) === JSON.stringify(current));
  return (
    <LiteralField p={p} htmlFor={id}>
      <select
        id={id}
        className="fk-input fk-select"
        value={index === -1 ? "" : String(index)}
        disabled={env.readOnly}
        aria-label={p.bare ? p.label : undefined}
        onChange={(e) => {
          const i = e.target.value;
          p.onChange(i === "" ? undefined : (values[Number(i)] as ValueExpr));
        }}
      >
        {(!always || index === -1) && (
          <option value="">{always ? labels.chooseOption : labels.noneOption}</option>
        )}
        {options.map((o, i) => (
          <option key={String(i)} value={String(i)}>
            {o.label}
          </option>
        ))}
      </select>
    </LiteralField>
  );
}

function isJsonLiteral(v: ValueExpr | undefined): boolean {
  return v !== undefined && typeof v !== "string" && !isExpr(v);
}

/**
 * A value of any type: text with pills, or JSON for numbers, lists and objects. In JSON,
 * references are pills too: a pill in value position is a reference, one inside a string makes a
 * template, and the picker and `{{` autocomplete insert them as in any text field.
 */
export function AnyField(p: FieldProps): JSX.Element {
  const env = useFormEnv();
  const { labels } = useFlowkitAppearance();
  const meta = fieldMetaOf(env, p.schema);
  const [json, setJson] = useState(() => isJsonLiteral(p.value));
  const [bad, setBad] = useState(false);
  // Like the `{x}` toggle: turning JSON off keeps the JSON value to restore when it's turned back on.
  const stash = useRef<ValueExpr | undefined>(undefined);
  const refOnly = meta.refOnly === true;
  const jsonMode = json || isJsonLiteral(p.value);
  const toggle =
    meta.literalOnly || refOnly ? undefined : (
      <AsideToggle
        on={jsonMode}
        label={labels.editAsJson}
        disabled={env.readOnly}
        onToggle={() => {
          if (jsonMode) {
            if (typeof p.value !== "string") {
              stash.current = p.value;
              p.onChange(undefined);
            }
          } else if (stash.current !== undefined) {
            if (p.value === undefined || p.value === "") p.onChange(stash.current);
            stash.current = undefined;
          }
          setBad(false);
          setJson(!jsonMode);
        }}
      >
        <Braces size={13} aria-hidden />
      </AsideToggle>
    );
  return (
    <FieldShell
      label={p.label}
      required={p.required}
      description={p.schema.description as string | undefined}
      issues={env.issues.filter((i) => i.field === p.path)}
      aside={toggle}
      bare={p.bare}
    >
      {jsonMode ? (
        <>
          <RefTextInput
            key="json"
            json
            multiline
            onJsonError={setBad}
            value={p.value}
            onChange={p.onChange}
            scope={env.scope}
            samples={env.samples}
            placeholder={labels.jsonPlaceholder}
            invalidRefs={env.invalidRefs}
            ariaLabel={p.label}
            literalOnly={meta.literalOnly === true}
            readOnly={env.readOnly}
          />
          {bad && <p className="fk-f__local">{labels.invalidJson}</p>}
        </>
      ) : (
        <RefTextInput
          key="text"
          value={p.value}
          onChange={p.onChange}
          scope={env.scope}
          samples={env.samples}
          multiline={meta.multiline === true}
          {...optional("placeholder", placeholderOf(p.schema))}
          invalidRefs={env.invalidRefs}
          ariaLabel={p.label}
          literalOnly={meta.literalOnly === true}
          singlePill={meta.refOnly === true}
          readOnly={env.readOnly}
        />
      )}
    </FieldShell>
  );
}
