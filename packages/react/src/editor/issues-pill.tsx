import {
  annotationRepairs,
  findStep,
  type Issue,
  type WorkflowDoc,
  walkSteps,
} from "@flowlinejs/core";
import { Plus, TriangleAlert, Wrench } from "lucide-react";
import { type JSX, useMemo, useRef, useState } from "react";
import { repairIssue } from "../canvas/actions";
import { useEditorStore, useEditorStoreApi, useIssues } from "../hooks";
import { useFlowlineAppearance } from "../provider";
import { TRIGGER_KEY } from "../store/editor-store";
import { Hint } from "../ui/primitives";
import { useOptionalToast } from "../ui/toaster";

/** Prefix of an {@link issueTargets} key that names a section rather than a step. */
const SECTION_PREFIX = "section:";

/** Whether an {@link issueTargets} key names a section (not a selectable step). */
export const isSectionTarget = (key: string): boolean => key.startsWith(SECTION_PREFIX);

/**
 * The target key of an issue: its step, else its section (a section issue whose first step is
 * missing), else the trigger.
 */
function targetKey(issue: Issue): string {
  if (issue.stepId !== undefined) return issue.stepId;
  if (issue.sectionId !== undefined) return `${SECTION_PREFIX}${issue.sectionId}`;
  return TRIGGER_KEY;
}

/**
 * Keys with issues, in tree order (trigger first), each with its first issue. A key is a
 * selection key, or `"section:<id>"` for a section issue that names no existing step (placed
 * just before its last step when that one exists, else last).
 */
export function issueTargets(doc: WorkflowDoc, issues: Issue[]): { key: string; issue: Issue }[] {
  const first = new Map<string, Issue>();
  for (const issue of issues) {
    const key = targetKey(issue);
    const had = first.get(key);
    // Errors take precedence over warnings as the step's headline issue.
    if (!had || (had.severity !== "error" && issue.severity === "error")) first.set(key, issue);
  }
  // Section keys go before their section's last step.
  const beforeStep = new Map<string, string[]>();
  for (const s of Array.isArray(doc.sections) ? doc.sections : []) {
    const key = `${SECTION_PREFIX}${String(s?.id)}`;
    if (!first.has(key) || typeof s?.last !== "string") continue;
    beforeStep.set(s.last, [...(beforeStep.get(s.last) ?? []), key]);
  }
  const order: string[] = [TRIGGER_KEY];
  walkSteps(doc, (s) => {
    order.push(...(beforeStep.get(s.id) ?? []), s.id);
  });
  const seen = new Set<string>();
  const out = order.flatMap((key) => {
    const issue = first.get(key);
    if (!issue || seen.has(key)) return [];
    seen.add(key);
    return [{ key, issue }];
  });
  // Issues of steps that no longer exist in the doc, and sections with no step left, go last.
  for (const [key, issue] of first) if (!seen.has(key)) out.push({ key, issue });
  return out;
}

/** How long the "+" under the trigger pulses after "Add a first step". */
const PULSE_MS = 1600;

/**
 * "2 issues": red with errors, amber with only warnings, hidden when the workflow is clean. Each
 * click selects the next step with an issue (in tree order, wrapping), which the canvas pans to.
 * A workflow with no steps (and nothing else wrong) reads "Add a first step" instead: a click
 * points out the "+" under the trigger and opens the step picker there.
 *
 * An annotation issue with a one-click repair (`section.broken`, `section.overlap`,
 * `note.tooLong`) gets a Fix button next to the pill, for the target cycled to (or the selected
 * step): the only way to fix a broken section that has no region to click, which cycling reaches
 * too. A fix toasts "Fixed: …" with Undo. Hidden on a read-only store.
 */
export function IssuesPill(): JSX.Element | null {
  const { labels } = useFlowlineAppearance();
  const { issues, errors } = useIssues();
  const store = useEditorStoreApi();
  const doc = useEditorStore((s) => s.doc);
  const readOnly = useEditorStore((s) => s.readOnly);
  const selection = useEditorStore((s) => s.selection);
  const select = useEditorStore((s) => s.select);
  const targets = useMemo(() => issueTargets(doc, issues), [doc, issues]);
  const fixable = useMemo(
    () => issues.filter((i) => annotationRepairs(doc, i).length > 0),
    [doc, issues],
  );
  const [cycling, setCycling] = useState(false);
  const pill = useRef<HTMLButtonElement>(null);
  const toast = useOptionalToast();
  // The section target last cycled to (it can't be the selection).
  const [sectionCursor, setSectionCursor] = useState<string | null>(null);
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

  const cursor = cycling && sectionCursor !== null ? sectionCursor : selection;
  const at = targets.findIndex((t) => t.key === cursor);
  const current = cycling && at !== -1 ? targets[at] : undefined;
  // The Fix on offer: the fixable issue of the target cycled to, else of the selection. Cycling
  // reaches every target, sections without a step included.
  const focusKey = current?.key ?? selection;
  const fix = readOnly ? undefined : fixable.find((i) => targetKey(i) === focusKey);
  // The hint names the issue Fix repairs when there is one.
  const shown = current && fix ? fix : current?.issue;
  const hint = shown
    ? `${labels.issuePosition(at + 1, targets.length)}: ${shown.message}`
    : labels.showNextIssue;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: groups the pill and its Fix, so cycling ends only when focus leaves both.
    <span
      className="fl-issues-group"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setCycling(false);
          setSectionCursor(null);
        }
      }}
    >
      <Hint content={hint}>
        <button
          ref={pill}
          type="button"
          className="fl-issues"
          data-tone={errors > 0 ? "danger" : "warning"}
          aria-description={labels.showNextIssue}
          onClick={() => {
            const next = targets[(at + 1) % targets.length];
            if (next) {
              if (isSectionTarget(next.key)) {
                setSectionCursor(next.key);
                // A section with no first step: show where it was (its last step), if anywhere.
                const id = next.key.slice(SECTION_PREFIX.length);
                const last = doc.sections?.find((s) => s?.id === id)?.last;
                if (typeof last === "string" && findStep(doc, last)) select(last);
              } else {
                setSectionCursor(null);
                select(next.key);
              }
            }
            setCycling(true);
          }}
        >
          <TriangleAlert size={13} strokeWidth={2.25} aria-hidden />
          <span>{labels.issueCount(issues.length)}</span>
        </button>
      </Hint>
      {fix && (
        <Hint content={fix.message}>
          <button
            type="button"
            className="fl-issues-fix"
            aria-description={fix.message}
            onClick={(e) => {
              const editor = e.currentTarget.closest(".fl-editor");
              if (!repairIssue(store, fix)) return;
              setSectionCursor(null);
              toast?.({
                message: labels.issueFixed(fix.message),
                action: {
                  label: labels.undo,
                  run: () => {
                    if (!store.getState().readOnly) store.getState().undo();
                  },
                },
              });
              // The Fix goes away with its issue: focus stays on the pill, or on the canvas
              // when the pill goes too.
              requestAnimationFrame(() => {
                if (pill.current?.isConnected) pill.current.focus();
                else editor?.querySelector<HTMLElement>(".fl-canvas")?.focus();
              });
            }}
          >
            <Wrench size={12} strokeWidth={2.25} aria-hidden />
            <span>{labels.fixIssue}</span>
          </button>
        </Hint>
      )}
    </span>
  );
}
