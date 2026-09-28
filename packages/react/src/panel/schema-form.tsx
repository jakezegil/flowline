/**
 * `SchemaForm`: renders a node's (or trigger's) config form from its JSON Schema and
 * `x-flowline` editor hints, and dispatches each field to a control.
 *
 * @module
 */
import {
  availableScope,
  hiddenFields,
  type Issue,
  type JSONSchema,
  type ScopeEntry,
  type ValueExpr,
} from "@flowline/core";
import * as Tooltip from "@radix-ui/react-tooltip";
import { ChevronRight } from "lucide-react";
import {
  type JSX,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { EditorContext } from "../hooks";
import { useFlowline } from "../provider";
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
 * One config field, rendered by (in order): a widget registered on `<FlowlineProvider widgets>`
 * under `x-flowline.widget`, a built-in widget of that name, or the control for its schema type.
 * Hidden fields render nothing.
 */
export function Field(input: FieldInput): JSX.Element | null {
  const env = useFormEnv();
  const { widgets } = useFlowline();
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

/** A collapsible group of fields (`x-flowline.group`). "Advanced" starts collapsed. */
function FieldGroup({
  title,
  hasIssues,
  children,
}: {
  title: string;
  hasIssues: boolean;
  children: JSX.Element[];
}): JSX.Element {
  const [open, setOpen] = useState(hasIssues || !/^advanced$/i.test(title.trim()));
  const id = useId();
  // Opens by itself when an issue appears inside, but can still be collapsed afterwards.
  useEffect(() => {
    if (hasIssues) setOpen(true);
  }, [hasIssues]);
  const shown = open;
  return (
    <section className="fl-group" data-open={shown ? "" : undefined}>
      <h3 className="fl-group__title">
        <button
          type="button"
          className="fl-group__toggle"
          aria-expanded={shown}
          aria-controls={id}
          onClick={() => setOpen(!shown)}
        >
          <ChevronRight size={14} className="fl-group__chev" aria-hidden />
          {title}
        </button>
      </h3>
      <div id={id} className="fl-fields" hidden={!shown}>
        {children}
      </div>
    </section>
  );
}

/**
 * The fields of an object schema, in declaration order: ungrouped fields first, then one
 * collapsible section per `x-flowline.group`.
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
  // Conditional fields (`showIf`) keep their value while hidden, so switching back restores it.
  // The same lookup as the validator's, so the form and the issues agree.
  const hidden = hiddenFields(value, s, env.root);
  for (const [key, raw] of propertiesOf(s)) {
    if (exclude?.includes(key)) continue;
    const prop = deref(env.root, raw);
    const meta = metaOf(unwrapNullable(env.root, prop));
    if (meta.hidden || hidden.has(key)) continue;
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
    <div className="fl-fields">
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
 * A config form generated from a JSON Schema with `x-flowline` editor hints.
 *
 * Controls by schema: text fields take literal text mixed with reference pills; numbers,
 * booleans (a switch) and choices (`enum`) take a literal or, via the `{x}` toggle, a reference;
 * lists of objects are repeatable groups (add, remove, reorder); objects with properties are
 * fieldsets; string maps are key/value rows; discriminated unions (`oneOf` of objects with a
 * constant property, e.g. `type`) show a choice and then that variant's fields. `x-flowline.widget`
 * selects a widget registered on `<FlowlineProvider widgets>`, else a built-in one (`rules`,
 * `cases`, `fields`, `code`, `subflowSelect`, `subflowInput`, `secret`, `textarea`).
 * `hidden` fields aren't rendered, `refOnly` fields take a single reference and `literalOnly`
 * fields never take one. Issues show under their field: errors red, warnings amber.
 *
 * Inside a `<WorkflowEditor>` (or an {@link EditorContext}), the fields' data pickers offer the
 * values in scope of `stepId` with their samples; elsewhere pass `scope` and `samples`. Needs a
 * `<FlowlineProvider>` above it.
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
  /** Literal values only: no `{x}` toggles or data picker (the trigger's config). */
  literalOnly?: boolean;
}): JSX.Element {
  const { schema, value, onChange, stepId, issues, readOnly = false, literalOnly = false } = props;
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
    () => ({
      root: schema,
      stepId,
      scope,
      samples,
      issues,
      invalidRefs,
      readOnly,
      values: value,
      literalOnly,
    }),
    [schema, stepId, scope, samples, issues, invalidRefs, readOnly, value, literalOnly],
  );
  return (
    <Tooltip.Provider delayDuration={300} skipDelayDuration={100}>
      <FormContext.Provider value={env}>
        <div className="fl-form">
          <ObjectFields schema={schema} path="" value={value} onChange={onChange} />
        </div>
      </FormContext.Provider>
    </Tooltip.Provider>
  );
}
