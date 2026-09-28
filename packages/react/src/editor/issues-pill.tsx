import { type Issue, type WorkflowDoc, walkSteps } from "@flowkit/core";
import { TriangleAlert } from "lucide-react";
import { type JSX, useMemo, useState } from "react";
import { useEditorStore, useIssues } from "../hooks";
import { useFlowkitAppearance } from "../provider";
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

/**
 * "2 issues": red with errors, amber with only warnings, hidden when the workflow is clean. Each
 * click selects the next step with an issue (in tree order, wrapping), which the canvas pans to.
 */
export function IssuesPill(): JSX.Element | null {
  const { labels } = useFlowkitAppearance();
  const { issues, errors } = useIssues();
  const doc = useEditorStore((s) => s.doc);
  const selection = useEditorStore((s) => s.selection);
  const select = useEditorStore((s) => s.select);
  const targets = useMemo(() => issueTargets(doc, issues), [doc, issues]);
  const [cycling, setCycling] = useState(false);
  if (issues.length === 0) return null;

  const at = targets.findIndex((t) => t.key === selection);
  const current = cycling && at !== -1 ? targets[at] : undefined;
  const hint = current
    ? `${labels.issuePosition(at + 1, targets.length)}: ${current.issue.message}`
    : labels.showNextIssue;
  return (
    <Hint content={hint}>
      <button
        type="button"
        className="fk-issues"
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
