/**
 * `SchemaForm`: renders a node's (or trigger's) config form from its JSON Schema and
 * `x-flowkit` editor hints, and dispatches each field to a control.
 *
 * @module
 */
import {
  availableScope,
  type Issue,
  type JSONSchema,
  type ScopeEntry,
  type ValueExpr,
} from "@flowkit/core";
import { ChevronRight } from "lucide-react";
import { type JSX, useContext, useId, useMemo, useState, useSyncExternalStore } from "react";
import { EditorContext } from "../hooks";
import { useFlowkit } from "../provider";
import type { EditorState, EditorStore } from "../store/editor-store";
import { ArrayField, MapField, ObjectField, UnionField } from "./fields/collections";
import { AnyField, BooleanField, EnumField, NumberField, StringField } from "./fields/controls";
import { FieldShell } from "./fields/shell";
import { type FieldProps, FormContext, type FormEnv, useFormEnv } from "./form-context";
import {
  deref,
  fieldKind,
  invalidRefsIn,
  issuesUnder,
  labelOf,
  metaOf,
  propertiesOf,
  requiredOf,
  unwrapNullable,
} from "./schema";
import { BUILTIN_WIDGETS } from "./widgets";

/** Props of {@link Field}: like {@link FieldProps}, with the schema as written. */
type FieldInput = Omit<FieldProps, "schema"> & { schema: JSONSchema };

/**
 * One config field, rendered by (in order): a widget registered on `<FlowkitProvider widgets>`
 * under `x-flowkit.widget`, a built-in widget of that name, or the control for its schema type.
 * Hidden fields render nothing.
 */
export function Field(input: FieldInput): JSX.Element | null {
  const env = useFormEnv();
  const { widgets } = useFlowkit();
  const schema = unwrapNullable(env.root, input.schema);
  const meta = metaOf(schema);
  if (meta.hidden) return null;
  const p: FieldProps = { ...input, schema };
  if (meta.widget) {
    const Custom = widgets[meta.widget];
    if (Custom) {
      return (
        <FieldShell
          label={p.label}
          required={p.required}
          description={schema.description as string | undefined}
          issues={issuesUnder(env.issues, p.path)}
          group
          bare={p.bare}
        >
          <Custom
            value={p.value}
            onChange={p.onChange}
            schema={schema}
            meta={meta}
            stepId={env.stepId}
            fieldKey={p.fieldKey}
            readOnly={env.readOnly}
          />
        </FieldShell>
      );
    }
    const Builtin = BUILTIN_WIDGETS[meta.widget];
    if (Builtin) return <Builtin {...p} />;
  }
  switch (fieldKind(env.root, schema)) {
    case "string":
      return <StringField {...p} />;
    case "number":
      return <NumberField {...p} />;
    case "boolean":
      return <BooleanField {...p} />;
    case "enum":
      return <EnumField {...p} />;
    case "array":
      return <ArrayField {...p} />;
    case "object":
      return <ObjectField {...p} />;
    case "map":
      return <MapField {...p} />;
    case "union":
      return <UnionField {...p} />;
    default:
      return <AnyField {...p} />;
  }
}

/** `obj` with `key` set to `v` (removed when `v` is `undefined`). */
export function withKey(
  obj: Record<string, ValueExpr> | undefined,
  key: string,
  v: ValueExpr | undefined,
): Record<string, ValueExpr> {
  const next = { ...obj };
  if (v === undefined) delete next[key];
  else next[key] = v;
  return next;
}

/** A plain object value, or `undefined`. */
export function asObject(v: ValueExpr | undefined): Record<string, ValueExpr> | undefined {
  return v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    !("$ref" in v) &&
    !("$tpl" in v)
    ? (v as Record<string, ValueExpr>)
    : undefined;
}

/** A collapsible group of fields (`x-flowkit.group`). "Advanced" starts collapsed. */
function FieldGroup({
  title,
  hasIssues,
  children,
}: {
  title: string;
  hasIssues: boolean;
  children: JSX.Element[];
}): JSX.Element {
  const [open, setOpen] = useState(!/^advanced$/i.test(title.trim()));
  const id = useId();
  const shown = open || hasIssues;
  return (
    <section className="fk-group" data-open={shown ? "" : undefined}>
      <h3 className="fk-group__title">
        <button
          type="button"
          className="fk-group__toggle"
          aria-expanded={shown}
          aria-controls={id}
          onClick={() => setOpen(!shown)}
        >
          <ChevronRight size={14} className="fk-group__chev" aria-hidden />
          {title}
        </button>
      </h3>
      <div id={id} className="fk-fields" hidden={!shown}>
        {children}
      </div>
    </section>
  );
}

/**
 * The fields of an object schema, in declaration order: ungrouped fields first, then one
 * collapsible section per `x-flowkit.group`.
 */
export function ObjectFields({
  schema,
  path,
  value,
  onChange,
  exclude,
}: {
  schema: JSONSchema;
  /** Issue path of the object (`""` at the top). */
  path: string;
  value: Record<string, ValueExpr> | undefined;
  onChange(key: string, v: ValueExpr | undefined): void;
  /** Property names not to render (e.g. a union's discriminator). */
  exclude?: string[];
}): JSX.Element {
  const env = useFormEnv();
  const s = deref(env.root, schema);
  const required = requiredOf(s);
  const loose: JSX.Element[] = [];
  const groups = new Map<string, { els: JSX.Element[]; issues: boolean }>();
  for (const [key, raw] of propertiesOf(s)) {
    if (exclude?.includes(key)) continue;
    const prop = deref(env.root, raw);
    const meta = metaOf(unwrapNullable(env.root, prop));
    if (meta.hidden) continue;
    const fieldPath = path === "" ? key : `${path}.${key}`;
    const el = (
      <Field
        key={key}
        schema={prop}
        fieldKey={key}
        path={fieldPath}
        label={labelOf(unwrapNullable(env.root, prop), key)}
        required={required.has(key)}
        value={value?.[key]}
        onChange={(v) => onChange(key, v)}
      />
    );
    if (typeof meta.group === "string" && meta.group !== "") {
      const g = groups.get(meta.group) ?? { els: [], issues: false };
      g.els.push(el);
      g.issues ||= issuesUnder(env.issues, fieldPath).length > 0;
      groups.set(meta.group, g);
    } else loose.push(el);
  }
  return (
    <div className="fk-fields">
      {loose}
      {[...groups].map(([title, g]) => (
        <FieldGroup key={title} title={title} hasIssues={g.issues}>
          {g.els}
        </FieldGroup>
      ))}
    </div>
  );
}

/** Renders an object form in a nested environment (different root schema or value). */
export function NestedForm({
  env: patch,
  children,
}: {
  env: Partial<FormEnv>;
  children: JSX.Element;
}): JSX.Element {
  const env = useFormEnv();
  const value = useMemo(() => ({ ...env, ...patch }), [env, patch]);
  return <FormContext.Provider value={value}>{children}</FormContext.Provider>;
}

const noSubscribe = () => () => {};

/** A slice of the editor store when there is one, else `fallback`. */
function useOptionalEditor<T>(
  store: EditorStore | null,
  select: (s: EditorState) => T,
  fallback: T,
): T {
  return useSyncExternalStore(
    store ? store.subscribe : noSubscribe,
    () => (store ? select(store.getState()) : fallback),
    () => (store ? select(store.getState()) : fallback),
  );
}

const NO_SAMPLES: Record<string, unknown> = {};
const NO_SCOPE: ScopeEntry[] = [];

/**
 * A config form generated from a JSON Schema with `x-flowkit` editor hints.
 *
 * Controls by schema: text fields take literal text mixed with reference pills; numbers,
 * booleans (a switch) and choices (`enum`) take a literal or, via the `{x}` toggle, a reference;
 * lists of objects are repeatable groups (add, remove, reorder); objects with properties are
 * fieldsets; string maps are key/value rows; discriminated unions (`oneOf` of objects with a
 * constant property, e.g. `type`) show a choice and then that variant's fields. `x-flowkit.widget`
 * selects a widget registered on `<FlowkitProvider widgets>`, else a built-in one (`rules`,
 * `cases`, `fields`, `code`, `subflowSelect`, `subflowInput`, `secret`, `textarea`).
 * `hidden` fields aren't rendered, `refOnly` fields take a single reference and `literalOnly`
 * fields never take one. Issues show under their field: errors red, warnings amber.
 *
 * Inside a `<WorkflowEditor>` (or an {@link EditorContext}), the fields' data pickers offer the
 * values in scope of `stepId` with their samples; elsewhere pass `scope` and `samples`. Needs a
 * `<FlowkitProvider>` above it.
 *
 * @example
 * <SchemaForm
 *   schema={nodeManifest.input}
 *   value={step.config}
 *   onChange={(key, v) => store.getState().setConfig(step.id, key, v)}
 *   stepId={step.id}
 *   issues={issuesOfStep}
 * />
 */
export function SchemaForm(props: {
  schema: JSONSchema;
  value: Record<string, ValueExpr>;
  onChange(key: string, v: ValueExpr | undefined): void;
  /** Step being configured (`"__trigger"` for the trigger). */
  stepId: string;
  /** Issues of this step; `field` paths are relative to `value`. */
  issues: Issue[];
  readOnly?: boolean;
  /** Values the fields may reference; defaults to the step's scope in the editor. */
  scope?: ScopeEntry[];
  /** Sample outputs by step ID; defaults to the editor's samples. */
  samples?: Record<string, unknown>;
}): JSX.Element {
  const { schema, value, onChange, stepId, issues, readOnly = false } = props;
  const store = useContext(EditorContext);
  const doc = useOptionalEditor(store, (s) => s.doc, null);
  const manifest = useOptionalEditor(store, (s) => s.manifest, null);
  const ctx = useOptionalEditor(store, (s) => s.ctx, null);
  const storeSamples = useOptionalEditor(store, (s) => s.samples, NO_SAMPLES);
  const scope = useMemo(
    () =>
      props.scope ??
      (doc && manifest ? availableScope(doc, stepId, manifest, ctx ?? {}) : NO_SCOPE),
    [props.scope, doc, manifest, ctx, stepId],
  );
  const samples = props.samples ?? storeSamples;
  const invalidRefs = useMemo(() => invalidRefsIn(value, scope), [value, scope]);
  const env = useMemo<FormEnv>(
    () => ({ root: schema, stepId, scope, samples, issues, invalidRefs, readOnly, values: value }),
    [schema, stepId, scope, samples, issues, invalidRefs, readOnly, value],
  );
  return (
    <FormContext.Provider value={env}>
      <div className="fk-form">
        <ObjectFields schema={schema} path="" value={value} onChange={onChange} />
      </div>
    </FormContext.Provider>
  );
}
