import { type Issue, type WorkflowDoc, walkSteps } from "@flowline/core";
import { Plus, TriangleAlert } from "lucide-react";
import { type JSX, useMemo, useState } from "react";
import { useEditorStore, useIssues } from "../hooks";
import { useFlowlineAppearance } from "../provider";
import { TRIGGER_KEY } from "../store/editor-store";
import { Hint } from "../ui/primitives";

/** Selection keys with issues, in tree order (trigger first), each with its first issue. */
export function issueTargets(doc: WorkflowDoc, issues: Issue[]): { key: string; issue: Issue }[] {
  const first = new Map<string, Issue>();
  for (const issue of issues) {
    const key = issue.stepId ?? TRIGGER_KEY;
    const had = first.get(key);
    // Errors take precedence over warnings as the step's headline issue.
    if (!had || (had.severity !== "error" && issue.severity === "error")) first.set(key, issue);
  }
  const order: string[] = [TRIGGER_KEY];
  walkSteps(doc, (s) => {
    order.push(s.id);
  });
  const out = order.flatMap((key) => {
    const issue = first.get(key);
    return issue ? [{ key, issue }] : [];
  });
  // Issues of steps that no longer exist in the doc (shouldn't happen) go last.
  for (const [key, issue] of first) if (!order.includes(key)) out.push({ key, issue });
  return out;
}

/** How long the "+" under the trigger pulses after "Add a first step". */
const PULSE_MS = 1600;

/**
 * "2 issues": red with errors, amber with only warnings, hidden when the workflow is clean. Each
 * click selects the next step with an issue (in tree order, wrapping), which the canvas pans to.
 * A workflow with no steps (and nothing else wrong) reads "Add a first step" instead: a click
 * points out the "+" under the trigger and opens the step picker there.
 */
export function IssuesPill(): JSX.Element | null {
  const { labels } = useFlowlineAppearance();
  const { issues, errors } = useIssues();
  const doc = useEditorStore((s) => s.doc);
  const selection = useEditorStore((s) => s.selection);
  const select = useEditorStore((s) => s.select);
  const targets = useMemo(() => issueTargets(doc, issues), [doc, issues]);
  const [cycling, setCycling] = useState(false);
  if (issues.length === 0) return null;

  if (issues.length === 1 && issues[0]?.code === "doc.empty") {
    const issue = issues[0];
    return (
      <Hint content={issue.message}>
        <button
          type="button"
          className="fl-issues"
          data-tone={errors > 0 ? "danger" : "warning"}
          onClick={(e) => {
            const plus = e.currentTarget
              .closest(".fl-editor")
              ?.querySelector<HTMLElement>('.fl-add[data-insert-at="//0"]');
            if (!plus) return;
            plus.dataset.pulse = "";
            setTimeout(() => delete plus.dataset.pulse, PULSE_MS);
            plus.click();
          }}
        >
          <Plus size={13} strokeWidth={2.25} aria-hidden />
          <span>{labels.addFirstStep}</span>
        </button>
      </Hint>
    );
  }

  const at = targets.findIndex((t) => t.key === selection);
  const current = cycling && at !== -1 ? targets[at] : undefined;
  const hint = current
    ? `${labels.issuePosition(at + 1, targets.length)}: ${current.issue.message}`
    : labels.showNextIssue;
  return (
    <Hint content={hint}>
      <button
        type="button"
        className="fl-issues"
        data-tone={errors > 0 ? "danger" : "warning"}
        aria-description={labels.showNextIssue}
        onClick={() => {
          const next = targets[(at + 1) % targets.length];
          if (next) select(next.key);
          setCycling(true);
        }}
        onBlur={() => setCycling(false)}
      >
        <TriangleAlert size={13} strokeWidth={2.25} aria-hidden />
        <span>{labels.issueCount(issues.length)}</span>
      </button>
    </Hint>
  );
}
