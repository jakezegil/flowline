/**
 * TEMPORARY placeholder of Task 15A's RefTextInput (see task-15-split.md): same props, a plain
 * input inside. Replaced by 15A's CodeMirror version when it merges.
 *
 * @module
 */
import { isRef, isTpl, parseTemplate, type ScopeEntry, type ValueExpr } from "@flowkit/core";
import type { JSX } from "react";

function toText(value: ValueExpr | undefined): string {
  if (value === undefined || value === null) return "";
  if (isRef(value)) return `{{${value.$ref}}}`;
  if (isTpl(value)) return value.$tpl;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function fromText(
  text: string,
  opts: { singlePill?: boolean; literalOnly?: boolean },
): ValueExpr | undefined {
  if (text === "") return undefined;
  if (opts.literalOnly) return text;
  const parts = parseTemplate(text);
  if (opts.singlePill) {
    const ref = parts.find((p) => "ref" in p);
    const path = ref && "ref" in ref ? ref.ref : text.trim();
    return path === "" ? undefined : { $ref: path };
  }
  if (parts.length === 1 && parts[0] && "ref" in parts[0]) return { $ref: parts[0].ref };
  if (parts.some((p) => "ref" in p)) return { $tpl: text };
  return text;
}

/** A text field mixing literal text and `{{ ref }}` pills. Placeholder until Task 15A lands. */
export function RefTextInput(props: {
  value: ValueExpr | undefined;
  onChange(v: ValueExpr | undefined): void;
  scope: ScopeEntry[];
  samples: Record<string, unknown>;
  multiline?: boolean;
  placeholder?: string;
  invalidRefs?: Set<string>;
  ariaLabel: string;
  singlePill?: boolean;
  literalOnly?: boolean;
  readOnly?: boolean;
}): JSX.Element {
  const text = toText(props.value);
  const invalid =
    props.invalidRefs !== undefined &&
    parseTemplate(text).some((p) => "ref" in p && props.invalidRefs?.has(p.ref));
  const common = {
    className: "fk-input fk-refinput-placeholder",
    value: text,
    "aria-label": props.ariaLabel,
    placeholder: props.placeholder,
    readOnly: props.readOnly,
    "data-invalid-ref": invalid ? "" : undefined,
    onChange: (e: { target: { value: string } }) => props.onChange(fromText(e.target.value, props)),
  };
  return props.multiline ? <textarea rows={3} {...common} /> : <input type="text" {...common} />;
}
