import type { Issue, NodeManifest, Step } from "@flowkit/core";
import * as Tooltip from "@radix-ui/react-tooltip";
import type { Node, NodeProps } from "@xyflow/react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Clock,
  LoaderCircle,
  Minus,
  TriangleAlert,
  X,
} from "lucide-react";
import { memo, type ReactNode, useContext, useEffect, useMemo, useRef } from "react";
import { stepIndex, useEditorStore, useEditorStoreApi, useShallow, useStep } from "../hooks";
import { useFlowkitAppearance } from "../provider";
import type { TestState } from "../store/editor-store";
import { stepActions } from "./actions";
import {
  PortalContainerContext,
  RootElementContext,
  type RunStepStatus,
  useCanvasUi,
  useCanvasUiApi,
} from "./canvas-context";
import { StepContextMenu, StepKebabMenu } from "./context-menu";
import { NodeHandles } from "./handles";
import { renderSummary, type SummaryPart, summaryStepRefs } from "./summary";

/** Data of a step node. */
export interface StepNodeData extends Record<string, unknown> {
  stepId: string;
  depth: number;
}

/** A step node. */
export type StepNode = Node<StepNodeData, "step">;

/** Formats a run duration: `850ms`, `1.2s`, `2m 5s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m}m ${s}s` : `${m}m`;
}

function issueSummary(issues: Issue[]): string {
  const n = issues.length;
  return `${n} ${n === 1 ? "issue" : "issues"}: ${issues.map((i) => i.message).join("; ")}`;
}

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
    <span className="fk-badge" data-tone={tone} role="img" aria-label={label}>
      {children}
    </span>
  );
  if (!tooltip) return badge;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{badge}</Tooltip.Trigger>
      <Tooltip.Portal container={container}>
        <Tooltip.Content className="fk-tooltip" side="top" sideOffset={6} collisionPadding={8}>
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
    <ul className="fk-tooltip__list">
      {issues.map((i) => (
        <li key={`${i.code}:${i.field ?? ""}:${i.message}`}>{i.message}</li>
      ))}
    </ul>
  );
}

/** Draft status badge: invalid, needs re-test or tested. */
export function DraftBadge({ issues, testState }: { issues: Issue[]; testState?: TestState }) {
  if (issues.length > 0) {
    const error = issues.some((i) => i.severity === "error");
    return (
      <Badge
        tone={error ? "danger" : "warning"}
        label={issueSummary(issues)}
        tooltip={<IssueList issues={issues} />}
      >
        <TriangleAlert size={11} strokeWidth={2.5} aria-hidden />
      </Badge>
    );
  }
  if (testState === "needs-test") {
    return (
      <Badge tone="warning" label="Edited since last test" tooltip="Edited since last test">
        <span className="fk-badge__dot" aria-hidden />
      </Badge>
    );
  }
  if (testState === "tested") {
    return (
      <Badge tone="success" label="Tested" tooltip="Tested">
        <Check size={11} strokeWidth={3} aria-hidden />
      </Badge>
    );
  }
  return null;
}

const RUN_LABEL: Record<RunStepStatus["status"], string> = {
  done: "Succeeded",
  failed: "Failed",
  running: "Running",
  waiting: "Waiting",
  skipped: "Skipped",
  pending: "Not run yet",
};

const RUN_TONE = {
  done: "success",
  failed: "danger",
  running: "accent",
  waiting: "warning",
  skipped: "muted",
  pending: "muted",
} as const satisfies Record<RunStepStatus["status"], string>;

/** Run status badge. */
function RunBadge({ run }: { run: RunStepStatus }) {
  const label = RUN_LABEL[run.status];
  const icon = {
    done: <Check size={11} strokeWidth={3} aria-hidden />,
    failed: <X size={11} strokeWidth={3} aria-hidden />,
    running: <LoaderCircle size={11} strokeWidth={2.5} className="fk-spin" aria-hidden />,
    waiting: <Clock size={11} strokeWidth={2.5} aria-hidden />,
    skipped: <Minus size={11} strokeWidth={3} aria-hidden />,
    pending: <CircleDashed size={11} strokeWidth={2.5} aria-hidden />,
  }[run.status];
  return (
    <Badge tone={RUN_TONE[run.status]} label={label} tooltip={label}>
      {icon}
    </Badge>
  );
}

/** Subtitle of a card in run mode: duration and retry count. */
function runSubtitle(run: RunStepStatus): string {
  const parts: string[] = [RUN_LABEL[run.status]];
  if (run.durationMs !== undefined) parts.push(formatDuration(run.durationMs));
  if (run.attempts !== undefined && run.attempts > 1) parts.push(`${run.attempts} attempts`);
  return parts.join(" · ");
}

/** Renders summary parts: text, ref pills and unset fields. */
export function SummaryLine({ parts }: { parts: SummaryPart[] }) {
  return (
    <span className="fk-summary">
      {parts.map((p, i) => {
        const key = `${i}:${p.kind}`;
        if (p.kind === "text") {
          return (
            <span key={key} className="fk-summary__text">
              {p.text}
            </span>
          );
        }
        if (p.kind === "ref") {
          return (
            <span key={key} className="fk-pill" title={p.ref}>
              {p.label}
            </span>
          );
        }
        return (
          <span key={key} className="fk-pill" data-empty>
            {p.label}
          </span>
        );
      })}
    </span>
  );
}

/** Inline name editor. Enter or blur saves, Escape cancels. */
function RenameInput({ initial, onDone }: { initial: string; onDone(name: string | null): void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      ref={ref}
      className="fk-card__rename nodrag nopan"
      defaultValue={initial}
      aria-label="Step name"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

/** Loop iteration stepper `‹ 3 / 12 ›` for run mode. */
function IterationStepper({ stepId }: { stepId: string }) {
  const iter = useCanvasUi((s) => s.overlay?.loopIteration[stepId]);
  const onChange = useCanvasUi((s) => s.overlay?.onIterationChange);
  if (!iter || iter.count === 0) return null;
  const go = (index: number) => onChange?.(stepId, Math.max(0, Math.min(iter.count - 1, index)));
  const failed = iter.failedIndex === iter.index;
  return (
    <div
      className="fk-iter nodrag nopan"
      role="toolbar"
      aria-label="Loop iteration"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        aria-label="Previous iteration"
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
        aria-label="Next iteration"
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
  const { resolveIcon } = useFlowkitAppearance();
  const readOnly = useCanvasUi((s) => s.readOnly);
  const renaming = useCanvasUi((s) => s.renaming === stepId);
  const run = useCanvasUi((s) => s.overlay?.stepStatus[stepId]);
  const inRunMode = useCanvasUi((s) => s.overlay !== undefined);
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
    return renderSummary(manifest.summary, step, (id) => names.get(id));
  }, [step, manifest, refIds, refNames]);

  if (!step) return null;
  const name = stepDisplayName(step, manifest);
  const Icon = resolveIcon(manifest?.icon);
  const control = manifest !== undefined && manifest.branches.kind !== "none";

  let subtitle: ReactNode;
  if (run) subtitle = runSubtitle(run);
  else if (!manifest) subtitle = `Unknown step type ${step.type}`;
  else if (parts && parts.length > 0) subtitle = <SummaryLine parts={parts} />;
  else if (step.name) subtitle = manifest.name;
  else if (manifest.description) subtitle = manifest.description;

  const card = (
    <div
      className="fk-card"
      data-selected={selected || undefined}
      data-disabled={step.disabled || undefined}
      data-unknown={!manifest || undefined}
      data-run={run?.status}
    >
      <div className="fk-card__icon" data-tone={control ? "control" : "action"} aria-hidden>
        <Icon size={18} />
      </div>
      <div className="fk-card__body">
        <div className="fk-card__title-row">
          {renaming && !readOnly ? (
            <RenameInput
              initial={step.name ?? name}
              onDone={(value) => {
                ui.getState().stopRename();
                if (value !== null) store.getState().renameStep(stepId, value);
              }}
            />
          ) : (
            // biome-ignore lint/a11y/noStaticElementInteractions: double-click to rename is a mouse shortcut; F2 and the menus are the keyboard path.
            <span
              className="fk-card__title"
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
          {step.disabled && <span className="fk-chip">Disabled</span>}
        </div>
        {subtitle !== undefined && <div className="fk-card__summary">{subtitle}</div>}
      </div>
      <div className="fk-card__aside" data-overlay={(!inRunMode && !readOnly) || undefined}>
        {inRunMode ? <IterationStepper stepId={stepId} /> : null}
        {!readOnly && (
          <StepKebabMenu step={step} manifest={manifest} actions={actions} name={name} />
        )}
      </div>
      <div className="fk-card__status">
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
