import type { Issue, NodeManifest, Step } from "@flowline/core";
import * as Tooltip from "@radix-ui/react-tooltip";
import type { Node, NodeProps } from "@xyflow/react";
import {
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  CircleStop,
  Clock,
  LoaderCircle,
  Minus,
  TriangleAlert,
  X,
} from "lucide-react";
import { memo, type ReactNode, useContext, useEffect, useMemo, useRef } from "react";
import {
  stepIndex,
  unreachableIds,
  useEditorStore,
  useEditorStoreApi,
  useShallow,
  useStep,
} from "../hooks";
import type { FlowlineLabels } from "../labels";
import { useFlowlineAppearance } from "../provider";
import type { TestState } from "../store/editor-store";
import { focusNode, stepActions } from "./actions";
import {
  PortalContainerContext,
  RootElementContext,
  type RunStepStatus,
  useCanvasUi,
  useCanvasUiApi,
  useLabels,
} from "./canvas-context";
import { StepContextMenu, StepKebabMenu } from "./context-menu";
import { NodeHandles } from "./handles";
import { renderSummary, type SummaryPart, summaryStepRefs, summaryText } from "./summary";

/** Data of a step node. */
export interface StepNodeData extends Record<string, unknown> {
  stepId: string;
  depth: number;
}

/** A step node. */
export type StepNode = Node<StepNodeData, "step">;

export { formatDuration } from "../labels";

/** A badge with a tooltip. The badge carries the full text as its accessible name. */
function Badge({
  tone,
  label,
  tooltip,
  children,
}: {
  tone: "danger" | "warning" | "success" | "accent" | "muted";
  label: string;
  tooltip?: ReactNode;
  children: ReactNode;
}) {
  const container = useContext(PortalContainerContext);
  const badge = (
    <span className="fl-badge" data-tone={tone} role="img" aria-label={label}>
      {children}
    </span>
  );
  if (!tooltip) return badge;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{badge}</Tooltip.Trigger>
      <Tooltip.Portal container={container}>
        <Tooltip.Content className="fl-tooltip" side="top" sideOffset={6} collisionPadding={8}>
          {tooltip}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** The issues list shown in an invalid badge's tooltip. */
function IssueList({ issues }: { issues: Issue[] }) {
  if (issues.length === 1) return <>{issues[0]?.message}</>;
  return (
    <ul className="fl-tooltip__list">
      {issues.map((i) => (
        <li key={`${i.code}:${i.field ?? ""}:${i.message}`}>{i.message}</li>
      ))}
    </ul>
  );
}

/** Draft status badge: invalid, needs re-test or tested. */
export function DraftBadge({ issues, testState }: { issues: Issue[]; testState?: TestState }) {
  const labels = useLabels();
  if (issues.length > 0) {
    const error = issues.some((i) => i.severity === "error");
    return (
      <Badge
        tone={error ? "danger" : "warning"}
        label={labels.issues(issues.map((i) => i.message))}
        tooltip={<IssueList issues={issues} />}
      >
        <TriangleAlert size={11} strokeWidth={2.5} aria-hidden />
      </Badge>
    );
  }
  if (testState === "needs-test") {
    return (
      <Badge tone="warning" label={labels.needsTest} tooltip={labels.needsTest}>
        <span className="fl-badge__dot" aria-hidden />
      </Badge>
    );
  }
  if (testState === "tested") {
    return (
      <Badge tone="success" label={labels.tested} tooltip={labels.tested}>
        <Check size={11} strokeWidth={3} aria-hidden />
      </Badge>
    );
  }
  return null;
}

const RUN_TONE = {
  done: "success",
  failed: "danger",
  running: "accent",
  waiting: "warning",
  skipped: "muted",
  pending: "muted",
  stopped: "muted",
  cancelled: "muted",
} as const satisfies Record<RunStepStatus["status"], string>;

/** Run status badge. */
function RunBadge({ run }: { run: RunStepStatus }) {
  const label = useLabels().runStatus[run.status];
  const icon = {
    done: <Check size={11} strokeWidth={3} aria-hidden />,
    failed: <X size={11} strokeWidth={3} aria-hidden />,
    running: <LoaderCircle size={11} strokeWidth={2.5} className="fl-spin" aria-hidden />,
    waiting: <Clock size={11} strokeWidth={2.5} aria-hidden />,
    skipped: <Minus size={11} strokeWidth={3} aria-hidden />,
    pending: <CircleDashed size={11} strokeWidth={2.5} aria-hidden />,
    stopped: <CircleStop size={11} strokeWidth={2.5} aria-hidden />,
    cancelled: <Ban size={11} strokeWidth={2.5} aria-hidden />,
  }[run.status];
  return (
    <Badge tone={RUN_TONE[run.status]} label={label} tooltip={label}>
      {icon}
    </Badge>
  );
}

/** Subtitle of a card in run mode: duration and retry count. */
function runSubtitle(run: RunStepStatus, labels: FlowlineLabels): string {
  const parts: string[] = [labels.runStatus[run.status]];
  if (run.durationMs !== undefined) parts.push(labels.duration(run.durationMs));
  if (run.attempts !== undefined && run.attempts > 1) parts.push(labels.attempts(run.attempts));
  return parts.join(" · ");
}

/** Renders summary parts: text, ref pills and unset fields. */
export function SummaryLine({ parts }: { parts: SummaryPart[] }) {
  // The whole summary as a tooltip, for when the card cuts it short.
  return (
    <span className="fl-summary" title={summaryText(parts)}>
      {parts.map((p, i) => {
        const key = `${i}:${p.kind}`;
        if (p.kind === "text") {
          return (
            <span key={key} className="fl-summary__text">
              {p.text}
            </span>
          );
        }
        if (p.kind === "ref") {
          return (
            <span key={key} className="fl-pill" title={p.label}>
              {p.label}
            </span>
          );
        }
        return (
          <span
            key={key}
            className="fl-summary__text fl-summary__unset"
            data-kind={p.kind === "default" ? "default" : "empty"}
          >
            {p.kind === "default" ? p.text : p.label}
          </span>
        );
      })}
    </span>
  );
}

/**
 * Inline name editor. Enter or blur saves, Escape cancels. `keyboard` is true when it ended
 * with Enter or Escape (focus should go back to the card) rather than by blurring.
 */
function RenameInput({
  initial,
  onDone,
}: {
  initial: string;
  onDone(name: string | null, keyboard: boolean): void;
}) {
  const labels = useLabels();
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (name: string | null, keyboard = false) => {
    if (done.current) return;
    done.current = true;
    onDone(name, keyboard);
  };
  return (
    <input
      ref={ref}
      className="fl-card__rename nodrag nopan"
      defaultValue={initial}
      aria-label={labels.stepName}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value, true);
        if (e.key === "Escape") finish(null, true);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

/**
 * Loop iteration stepper `‹ 3 / 12 ›` for run mode. Red when the loop failed and the shown
 * iteration is the failed one.
 */
function IterationStepper({ stepId, run }: { stepId: string; run: RunStepStatus }) {
  const iter = useCanvasUi((s) => s.overlay?.loopIteration[stepId]);
  const onChange = useCanvasUi((s) => s.overlay?.onIterationChange);
  const labels = useLabels();
  if (!iter || iter.count === 0) return null;
  const go = (index: number) => onChange?.(stepId, Math.max(0, Math.min(iter.count - 1, index)));
  const failed =
    iter.failedIndices !== undefined
      ? iter.failedIndices.includes(iter.index)
      : run.status === "failed" &&
        (iter.failedIndex === undefined || iter.failedIndex === iter.index);
  return (
    <div
      className="fl-iter nodrag nopan"
      role="toolbar"
      aria-label={labels.loopIteration}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        aria-label={labels.previousIteration}
        disabled={iter.index <= 0}
        onClick={() => go(iter.index - 1)}
      >
        <ChevronLeft size={12} aria-hidden />
      </button>
      <span data-failed={failed || undefined} aria-live="polite">
        {iter.index + 1} / {iter.count}
      </span>
      <button
        type="button"
        aria-label={labels.nextIteration}
        disabled={iter.index >= iter.count - 1}
        onClick={() => go(iter.index + 1)}
      >
        <ChevronRight size={12} aria-hidden />
      </button>
    </div>
  );
}

/** Display name of a step: its name override, else its node's name, else its ID. */
export function stepDisplayName(step: Step, manifest: NodeManifest | undefined): string {
  return step.name ?? manifest?.name ?? step.id;
}

/**
 * A step's card: icon, name, rendered summary (or run duration), status badge and actions.
 * Re-renders only when its own step, issues, test state or run status change.
 */
export const StepCard = memo(function StepCard({ data, selected }: NodeProps<StepNode>) {
  const { stepId } = data;
  const info = useStep(stepId);
  const store = useEditorStoreApi();
  const ui = useCanvasUiApi();
  const root = useContext(RootElementContext);
  const { resolveIcon } = useFlowlineAppearance();
  const readOnly = useCanvasUi((s) => s.readOnly);
  const renaming = useCanvasUi((s) => s.renaming === stepId);
  const run = useCanvasUi((s) => s.overlay?.stepStatus[stepId]);
  const labels = useLabels();
  const inRunMode = useCanvasUi((s) => s.overlay !== undefined);
  const dimmed = useCanvasUi((s) => s.overlay?.dimmedSteps?.has(stepId) ?? false);
  const unreachable = useEditorStore((s) => unreachableIds(s.doc, s.manifest).has(stepId));
  const actions = useMemo(() => stepActions(store, ui, root, stepId), [store, ui, root, stepId]);

  const step = info?.step;
  const manifest = info?.manifest;
  const refIds = useMemo(
    () => (step ? summaryStepRefs(manifest?.summary, step) : []),
    [step, manifest],
  );
  const refNames = useEditorStore(
    useShallow((s) =>
      refIds.map((id) => {
        const target = stepIndex(s.doc).get(id);
        if (!target) return undefined;
        return stepDisplayName(
          target,
          s.manifest.nodes.find((m) => m.type === target.type),
        );
      }),
    ),
  );
  const parts = useMemo(() => {
    if (!step || !manifest?.summary) return undefined;
    const names = new Map(refIds.map((id, i) => [id, refNames[i]]));
    return renderSummary(manifest.summary, step, (id) => names.get(id), manifest.input, labels);
  }, [step, manifest, refIds, refNames, labels]);

  if (!step) return null;
  const name = stepDisplayName(step, manifest);
  const Icon = resolveIcon(manifest?.icon);
  const control = manifest !== undefined && manifest.branches.kind !== "none";

  let subtitle: ReactNode;
  if (run) subtitle = runSubtitle(run, labels);
  else if (unreachable) subtitle = labels.neverRuns;
  else if (!manifest) subtitle = labels.unknownStep(step.type);
  else if (parts?.blank && manifest.description) subtitle = manifest.description;
  else if (parts && parts.parts.length > 0) subtitle = <SummaryLine parts={parts.parts} />;
  else if (step.name) subtitle = manifest.name;
  else if (manifest.description) subtitle = manifest.description;

  const card = (
    <div
      className="fl-card"
      data-selected={selected || undefined}
      data-disabled={step.disabled || undefined}
      data-unknown={!manifest || undefined}
      data-run={run?.status}
      data-dimmed={dimmed || undefined}
      data-unreachable={(unreachable && !inRunMode) || undefined}
    >
      <div className="fl-card__icon" data-tone={control ? "control" : "action"} aria-hidden>
        <Icon size={18} />
      </div>
      <div className="fl-card__body">
        <div className="fl-card__title-row">
          {renaming && !readOnly ? (
            <RenameInput
              initial={step.name ?? name}
              onDone={(value, keyboard) => {
                ui.getState().stopRename();
                if (value !== null) store.getState().renameStep(stepId, value);
                if (keyboard) focusNode(root(), stepId);
              }}
            />
          ) : (
            // biome-ignore lint/a11y/noStaticElementInteractions: double-click to rename is a mouse shortcut; F2 and the menus are the keyboard path.
            <span
              className="fl-card__title"
              title={name}
              onDoubleClick={
                readOnly
                  ? undefined
                  : (e) => {
                      e.stopPropagation();
                      actions.rename();
                    }
              }
            >
              {name}
            </span>
          )}
          {step.disabled && <span className="fl-chip">{labels.disabled}</span>}
        </div>
        {subtitle !== undefined && <div className="fl-card__summary">{subtitle}</div>}
      </div>
      <div className="fl-card__aside" data-overlay={(!inRunMode && !readOnly) || undefined}>
        {run && run.status !== "pending" && run.status !== "skipped" ? (
          <IterationStepper stepId={stepId} run={run} />
        ) : null}
        {!readOnly && (
          <StepKebabMenu step={step} manifest={manifest} actions={actions} name={name} />
        )}
      </div>
      <div className="fl-card__status">
        {run ? (
          <RunBadge run={run} />
        ) : (
          !inRunMode && <DraftBadge issues={info.issues} testState={info.testState} />
        )}
      </div>
    </div>
  );
  return (
    <>
      <NodeHandles />
      {readOnly ? (
        card
      ) : (
        <StepContextMenu step={step} manifest={manifest} actions={actions}>
          {card}
        </StepContextMenu>
      )}
    </>
  );
});
