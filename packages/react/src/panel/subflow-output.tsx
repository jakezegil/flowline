/**
 * A sub-flow's output mapping (`doc.output`) in the trigger panel: one reference field per
 * declared output field, drawing on the scope at the end of the workflow.
 *
 * @module
 */
import {
  availableScope,
  type Issue,
  type ScopeEntry,
  subflowOutputFields,
  type ValueExpr,
} from "@flowkit/core";
import { X } from "lucide-react";
import { type JSX, useMemo } from "react";
import { useEditorStore } from "../hooks";
import { useFlowkitAppearance } from "../provider";
import { FieldShell } from "./fields/shell";
import { RefTextInput } from "./ref-text-input";
import { invalidRefsIn } from "./schema";

const OUTPUT_PREFIX = "output.";

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
 * The output mapping editor: each output field declared by the sub-flow trigger (config
 * `"output"`) takes text and reference pills from the trigger and top-level steps. Mapped keys
 * that aren't declared are listed with a remove button. Issues show under their output.
 */
export function SubflowOutput(): JSX.Element {
  const { labels } = useFlowkitAppearance();
  const doc = useEditorStore((s) => s.doc);
  const manifest = useEditorStore((s) => s.manifest);
  const ctx = useEditorStore((s) => s.ctx);
  const samples = useEditorStore((s) => s.samples);
  const allIssues = useEditorStore((s) => s.issues);
  const setOutput = useEditorStore((s) => s.setOutput);
  const trigger = manifest.triggers.find((t) => t.type === doc.trigger.type);
  const declared = subflowOutputFields(trigger, doc.trigger) ?? [];
  const output: Record<string, ValueExpr> = doc.output ?? {};
  // The mapping is evaluated when the run finishes: the trigger and top-level steps are in scope.
  const scope = useMemo<ScopeEntry[]>(
    () => availableScope(doc, null, manifest, ctx),
    [doc, manifest, ctx],
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
      <div className="fk-fields fk-output">
        {declared.length === 0 && extra.length === 0 && (
          <p className="fk-empty-note">{labels.outputMappingEmpty}</p>
        )}
        {declared.map((d) => (
          <FieldShell
            key={d.name}
            label={d.name}
            required={d.required === true}
            {...(d.description ? { description: d.description } : {})}
            issues={issuesOf(issues, d.name)}
            aside={<span className="fk-output__type">{labels.fieldTypes[d.type]}</span>}
          >
            <RefTextInput
              value={output[d.name]}
              onChange={(v) => setOutput(d.name, v)}
              scope={scope}
              samples={samples}
              invalidRefs={invalidRefs}
              ariaLabel={labels.outputValue(d.name)}
            />
          </FieldShell>
        ))}
        {extra.map((key) => (
          <FieldShell
            key={key}
            label={key}
            description={labels.outputUndeclared}
            issues={issuesOf(issues, key)}
            aside={
              <button
                type="button"
                className="fk-icon-btn"
                aria-label={labels.removeOutput(key)}
                title={labels.removeOutput(key)}
                onClick={() => setOutput(key, undefined)}
              >
                <X size={14} aria-hidden />
              </button>
            }
          >
            <RefTextInput
              value={output[key]}
              onChange={(v) => setOutput(key, v)}
              scope={scope}
              samples={samples}
              invalidRefs={invalidRefs}
              ariaLabel={labels.outputValue(key)}
            />
          </FieldShell>
        ))}
      </div>
    </FieldShell>
  );
}
