/**
 * Built-in config widgets, selected by `x-flowkit.widget` when the provider registers no widget
 * of that name.
 *
 * @module
 */
import type { ComponentType, JSX } from "react";
import { CodeEditor } from "../code-editor";
import { StringField } from "../fields/controls";
import { FieldShell } from "../fields/shell";
import { type FieldProps, useFormEnv } from "../form-context";
import { issuesUnder } from "../schema";
import { CasesWidget } from "./cases";
import { FieldsWidget } from "./fields";
import { SecretWidget, SubflowInputWidget, SubflowSelectWidget } from "./remote";
import { RulesWidget } from "./rules";

/** The `"code"` widget: a JavaScript editor with `steps` / `trigger` completions. */
function CodeWidget(p: FieldProps): JSX.Element {
  const env = useFormEnv();
  return (
    <FieldShell
      label={p.label}
      required={p.required}
      description={p.schema.description as string | undefined}
      issues={issuesUnder(env.issues, p.path)}
      bare={p.bare}
    >
      <CodeEditor
        value={typeof p.value === "string" ? p.value : ""}
        onChange={(v) => p.onChange(v === "" ? undefined : v)}
        scope={env.scope}
        ariaLabel={p.label}
        readOnly={env.readOnly}
      />
    </FieldShell>
  );
}

/** @internal Built-in widgets by name. */
export const BUILTIN_WIDGETS: Record<string, ComponentType<FieldProps>> = {
  rules: RulesWidget,
  cases: CasesWidget,
  fields: FieldsWidget,
  code: CodeWidget,
  subflowSelect: SubflowSelectWidget,
  subflowInput: SubflowInputWidget,
  secret: SecretWidget,
  textarea: StringField,
};
