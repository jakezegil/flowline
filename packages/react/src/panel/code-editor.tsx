/**
 * TEMPORARY placeholder of Task 15A's CodeEditor (see task-15-split.md): same props, a textarea
 * inside. Replaced by 15A's CodeMirror version when it merges.
 *
 * @module
 */
import type { ScopeEntry } from "@flowkit/core";
import type { JSX } from "react";

/** A JavaScript editor for the `"code"` widget. Placeholder until Task 15A lands. */
export function CodeEditor(props: {
  value: string;
  onChange(v: string): void;
  scope: ScopeEntry[];
  ariaLabel: string;
  readOnly?: boolean;
}): JSX.Element {
  return (
    <textarea
      className="fk-input fk-input--mono"
      rows={8}
      spellCheck={false}
      value={props.value}
      aria-label={props.ariaLabel}
      readOnly={props.readOnly}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}
