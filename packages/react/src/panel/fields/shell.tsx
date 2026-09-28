/**
 * Building blocks shared by the config form's fields: the labelled field frame with help text and
 * issues, the reference-mode toggle, a segmented choice and a switch.
 *
 * @module
 */
import type { Issue } from "@flowkit/core";
import { CircleAlert, TriangleAlert } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { useFlowkitAppearance } from "../../provider";
import { Hint } from "../../ui/primitives";

/** A field's issues, errors first, each with its icon. */
export function IssueNotes({ issues }: { issues: readonly Issue[] }): JSX.Element | null {
  if (issues.length === 0) return null;
  const sorted = [...issues].sort(
    (a, b) => (a.severity === "error" ? 0 : 1) - (b.severity === "error" ? 0 : 1),
  );
  return (
    <ul className="fk-f__issues">
      {sorted.map((i) => (
        <li key={`${i.code}:${i.field ?? ""}:${i.message}`} data-severity={i.severity}>
          {i.severity === "error" ? (
            <CircleAlert size={13} aria-hidden />
          ) : (
            <TriangleAlert size={13} aria-hidden />
          )}
          <span>{i.message}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A labelled field: label (with required marker and an optional toggle on the right), the
 * control, help text and issues. `group` renders a fieldset for controls made of several inputs.
 */
export function FieldShell(props: {
  label: string;
  required?: boolean;
  description?: string;
  issues: readonly Issue[];
  /** ID of the control the label names (native inputs). */
  htmlFor?: string;
  /** Extra controls at the end of the label row, e.g. the reference toggle. */
  aside?: ReactNode;
  /** Put the control on the label row (switches). */
  inline?: boolean;
  group?: boolean;
  /** No label row: the control (and `aside` beside it), then issues. For list items. */
  bare?: boolean;
  children: ReactNode;
}): JSX.Element {
  const { labels } = useFlowkitAppearance();
  const invalid = props.issues.some((i) => i.severity === "error");
  const warned = !invalid && props.issues.length > 0;
  const label = (
    <>
      {props.label}
      {props.required && (
        <span className="fk-f__req">
          <span aria-hidden>*</span>
          <span className="fk-sr-only">{labels.requiredField}</span>
        </span>
      )}
    </>
  );
  const head = (
    <div className="fk-f__head">
      {props.group ? (
        <legend className="fk-f__label">{label}</legend>
      ) : (
        <label className="fk-f__label" htmlFor={props.htmlFor}>
          {label}
        </label>
      )}
      {props.aside && <div className="fk-f__aside">{props.aside}</div>}
      {props.inline && <div className="fk-f__inline">{props.children}</div>}
    </div>
  );
  const body = (
    <>
      {head}
      {!props.inline && props.children}
      {props.description && <p className="fk-f__help">{props.description}</p>}
      <IssueNotes issues={props.issues} />
    </>
  );
  if (props.bare) {
    return (
      <div className="fk-f fk-f--bare" data-invalid={invalid ? "" : undefined}>
        {props.aside ? (
          <div className="fk-f__row">
            <div className="fk-f__grow">{props.children}</div>
            {props.aside}
          </div>
        ) : (
          props.children
        )}
        <IssueNotes issues={props.issues} />
      </div>
    );
  }
  const attrs = {
    className: "fk-f",
    "data-invalid": invalid ? "" : undefined,
    "data-warning": warned ? "" : undefined,
  };
  return props.group ? <fieldset {...attrs}>{body}</fieldset> : <div {...attrs}>{body}</div>;
}

/** The `{x}` toggle between a literal control and a reference. */
export function RefToggle({
  on,
  onToggle,
  disabled,
}: {
  on: boolean;
  onToggle(): void;
  disabled?: boolean;
}): JSX.Element {
  const { labels } = useFlowkitAppearance();
  const text = on ? labels.useLiteral : labels.useReference;
  return (
    <Hint content={text} side="left">
      <button
        type="button"
        className="fk-reftoggle"
        aria-pressed={on}
        aria-label={labels.useReference}
        disabled={disabled}
        onClick={onToggle}
      >
        {"{x}"}
      </button>
    </Hint>
  );
}

/** A small icon/text toggle button in a field's label row. */
export function AsideToggle({
  on,
  label,
  onToggle,
  disabled,
  children,
}: {
  on: boolean;
  label: string;
  onToggle(): void;
  disabled?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <Hint content={label} side="left">
      <button
        type="button"
        className="fk-reftoggle"
        aria-pressed={on}
        aria-label={label}
        disabled={disabled}
        onClick={onToggle}
      >
        {children}
      </button>
    </Hint>
  );
}

/** A row of mutually exclusive options (radio semantics). */
export function Segmented<T extends string | number | boolean>(props: {
  label: string;
  options: { value: T; label: string }[];
  value: T | undefined;
  onChange(v: T): void;
  disabled?: boolean;
  id?: string;
}): JSX.Element {
  const index = props.options.findIndex((o) => o.value === props.value);
  const move = (delta: number) => {
    const n = props.options.length;
    const next = props.options[((index === -1 ? 0 : index) + delta + n) % n];
    if (next) props.onChange(next.value);
  };
  return (
    <div
      className="fk-seg"
      role="radiogroup"
      aria-label={props.label}
      id={props.id}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {props.options.map((o, i) => {
        const checked = o.value === props.value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a segmented control of buttons, with radio semantics and roving focus.
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked || (index === -1 && i === 0) ? 0 : -1}
            className="fk-seg__opt"
            disabled={props.disabled}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** An on/off switch. */
export function Switch(props: {
  checked: boolean;
  onChange(v: boolean): void;
  label: string;
  id?: string;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      id={props.id}
      aria-checked={props.checked}
      aria-label={props.label}
      className="fk-switch"
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="fk-switch__thumb" aria-hidden />
    </button>
  );
}
