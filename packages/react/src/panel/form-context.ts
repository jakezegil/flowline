import type { Issue, JSONSchema, ScopeEntry, ValueExpr } from "@flowkit/core";
import { createContext, useContext } from "react";

/** What every field of a {@link SchemaForm} needs besides its own value. */
export interface FormEnv {
  /** Root schema that local `$ref`s resolve against. */
  root: JSONSchema;
  /** Step being configured (`"__trigger"` for the trigger). */
  stepId: string;
  /** Values the fields may reference. */
  scope: ScopeEntry[];
  /** Sample outputs by step ID, for the data picker. */
  samples: Record<string, unknown>;
  /** The step's issues, with `field` paths relative to the form's value. */
  issues: Issue[];
  /** Reference paths used in the form that don't resolve. */
  invalidRefs: Set<string>;
  readOnly: boolean;
  /** The form's whole value, for widgets that depend on a sibling field. */
  values: Record<string, ValueExpr>;
}

/** @internal Props of every field renderer. */
export interface FieldProps {
  /** The field's schema, dereferenced with nullability stripped. */
  schema: JSONSchema;
  /** Key in the parent object (or `String(index)` for list items). */
  fieldKey: string;
  /** Issue path, e.g. `"headers.accept"` or `"cases[1].label"`. */
  path: string;
  label: string;
  required: boolean;
  value: ValueExpr | undefined;
  onChange(v: ValueExpr | undefined): void;
  /** No label row (list items); the label still names the control for assistive tech. */
  bare?: boolean;
}

/** @internal */
export const FormContext = createContext<FormEnv | null>(null);

/** @internal The enclosing form's environment. */
export function useFormEnv(): FormEnv {
  const env = useContext(FormContext);
  if (!env) throw new Error("Config fields must be rendered inside <SchemaForm>");
  return env;
}
