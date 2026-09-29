/**
 * A sub-flow's output mapping (`doc.output`) in the trigger panel: a {@link SchemaForm} over the
 * declared output fields, drawing on the scope at the end of the workflow.
 *
 * @module
 */
import {
  availableScope,
  type FieldDecl,
  fieldsToJsonSchema,
  type Issue,
  type JSONSchema,
  type ScopeEntry,
  subflowOutputFields,
  UI_META_KEY,
  type ValueExpr,
  type WorkflowDoc,
} from "@flowlinejs/core";
import { X } from "lucide-react";
import { type JSX, useMemo } from "react";
import { useEditorStore } from "../hooks";
import { useFlowlineAppearance } from "../provider";
import { TRIGGER_KEY } from "../store/editor-store";
import { FieldShell } from "./fields/shell";
import { RefTextInput } from "./ref-text-input";
import { invalidRefsIn } from "./schema";
import { SchemaForm } from "./schema-form";

const OUTPUT_PREFIX = "output.";
const NO_OUTPUT: Record<string, ValueExpr> = {};
const NO_DECLS: FieldDecl[] = [];

/** Issues of the output mapping, with `field` relative to it (`"output.x"` → `"x"`). */
export function outputIssues(issues: readonly Issue[]): Issue[] {
  const out: Issue[] = [];
  for (const i of issues) {
    if (i.stepId === undefined && i.field?.startsWith(OUTPUT_PREFIX)) {
      out.push({ ...i, field: i.field.slice(OUTPUT_PREFIX.length) });
    }
  }
  return out;
}

/** Issues of output `key` and anything below it. */
function issuesOf(issues: readonly Issue[], key: string): Issue[] {
  return issues.filter(
    (i) => i.field === key || i.field?.startsWith(`${key}.`) || i.field?.startsWith(`${key}[`),
  );
}

/** Whether the trigger panel shows the output mapping: a sub-flow, or a doc that has one. */
export function useHasOutputMapping(): boolean {
  return useEditorStore((s) => {
    const t = s.manifest.triggers.find((x) => x.type === s.doc.trigger.type);
    return t?.kind === "subflow" || Object.keys(s.doc.output ?? {}).length > 0;
  });
}

/**
 * The form schema of the declared outputs: each field's own type, so numbers, booleans and text
 * get their typed controls (with the `{x}` toggle for a reference). Objects and lists take any
 * value, a reference or JSON, since a declaration says nothing about their shape. Labels are the
 * field names, as callers see them; each help line starts with the declared type.
 */
function outputFormSchema(declared: FieldDecl[], typeLabel: (d: FieldDecl) => string): JSONSchema {
  const base = fieldsToJsonSchema(declared);
  const props = base.properties as Record<string, JSONSchema>;
  for (const d of declared) {
    const typed = props[d.name] ?? {};
    const loose = d.type === "object" || d.type === "array";
    const type = typeLabel(d);
    props[d.name] = {
      ...(loose ? {} : typed),
      // The declared type leads the help line: typed controls don't say "Text" or "Date".
      description: d.description ? `${type} · ${d.description}` : type,
      [UI_META_KEY]: { label: d.name },
    };
  }
  return base;
}

/**
 * The output mapping editor: a form over the output fields declared by the sub-flow trigger
 * (config `"output"`), each taking a literal of its type or references to the trigger and
 * top-level steps. Mapped keys that aren't declared are listed with a remove button. Issues show
 * under their output.
 */
export function SubflowOutput(): JSX.Element {
  const { labels } = useFlowlineAppearance();
  const trigger = useEditorStore((s) => s.doc.trigger);
  const steps = useEditorStore((s) => s.doc.steps);
  const output = useEditorStore((s) => s.doc.output) ?? NO_OUTPUT;
  const manifest = useEditorStore((s) => s.manifest);
  const ctx = useEditorStore((s) => s.ctx);
  const samples = useEditorStore((s) => s.samples);
  const allIssues = useEditorStore((s) => s.issues);
  const setOutputAction = useEditorStore((s) => s.setOutput);
  const readOnly = useEditorStore((s) => s.readOnly);
  const setOutput: typeof setOutputAction = (key, value) => {
    if (!readOnly) setOutputAction(key, value);
  };
  const triggerManifest = manifest.triggers.find((t) => t.type === trigger.type);
  const declared = useMemo(
    () => subflowOutputFields(triggerManifest, trigger) ?? NO_DECLS,
    [triggerManifest, trigger],
  );
  // The mapping is evaluated when the run finishes: the trigger and top-level steps are in scope.
  const scope = useMemo<ScopeEntry[]>(() => {
    const doc = { id: "", name: "", trigger, steps } as WorkflowDoc;
    return availableScope(doc, null, manifest, ctx);
  }, [trigger, steps, manifest, ctx]);
  const schema = useMemo(
    () => outputFormSchema(declared, (d) => labels.fieldTypes[d.type]),
    [declared, labels],
  );
  const invalidRefs = useMemo(() => invalidRefsIn(output, scope), [output, scope]);
  const issues = useMemo(() => outputIssues(allIssues), [allIssues]);
  const names = new Set(declared.map((d) => d.name));
  const extra = Object.keys(output).filter((k) => !names.has(k));
  const loose = issues.filter((i) => i.field === undefined);

  return (
    <FieldShell
      label={labels.outputMapping}
      description={labels.outputMappingHint}
      issues={loose}
      group
    >
      <div className="fl-fields fl-output">
        {declared.length === 0 && extra.length === 0 && (
          <p className="fl-empty-note">{labels.outputMappingEmpty}</p>
        )}
        {declared.length > 0 && (
          <SchemaForm
            schema={schema}
            value={output}
            onChange={setOutput}
            stepId={TRIGGER_KEY}
            issues={issues}
            readOnly={readOnly}
            scope={scope}
            samples={samples}
          />
        )}
        {extra.map((key) => {
          const keyIssues = issuesOf(issues, key);
          return (
            <FieldShell
              key={key}
              label={key}
              // The validator's `output.unknown` issue says it already; don't say it twice.
              description={keyIssues.length > 0 ? undefined : labels.outputUndeclared}
              issues={keyIssues}
              aside={
                readOnly ? undefined : (
                  <button
                    type="button"
                    className="fl-icon-btn"
                    aria-label={labels.removeOutput(key)}
                    title={labels.removeOutput(key)}
                    onClick={() => setOutput(key, undefined)}
                  >
                    <X size={14} aria-hidden />
                  </button>
                )
              }
            >
              <RefTextInput
                value={output[key]}
                onChange={(v) => setOutput(key, v)}
                scope={scope}
                samples={samples}
                invalidRefs={invalidRefs}
                ariaLabel={labels.outputValue(key)}
                readOnly={readOnly}
              />
            </FieldShell>
          );
        })}
      </div>
    </FieldShell>
  );
}
