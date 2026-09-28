/**
 * TEMPORARY placeholder of Task 15A's DataPicker (see task-15-split.md): same props, a flat list
 * of scope entries inside. Replaced by 15A's version when it merges.
 *
 * @module
 */
import type { JSONSchema, ScopeEntry } from "@flowkit/core";
import type { JSX } from "react";

/** The tree of values in scope, for inserting references. Placeholder until Task 15A lands. */
export function DataPicker(props: {
  scope: ScopeEntry[];
  samples: Record<string, unknown>;
  onPick(refPath: string, typeLabel: string): void;
  filterType?: JSONSchema;
}): JSX.Element {
  return (
    <ul className="fk-datapicker-placeholder">
      {props.scope.map((e) => (
        <li key={e.refBase}>
          <button type="button" onClick={() => props.onPick(e.refBase, "any")}>
            {e.label}
          </button>
        </li>
      ))}
    </ul>
  );
}
