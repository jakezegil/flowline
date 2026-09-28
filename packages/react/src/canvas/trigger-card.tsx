import type { Issue, TriggerManifest, WorkflowDoc } from "@flowkit/core";
import type { Node, NodeProps } from "@xyflow/react";
import { Zap } from "lucide-react";
import { memo, useRef } from "react";
import { sameIssues, useEditorStore, useShallow } from "../hooks";
import type { FlowkitLabels } from "../labels";
import { useFlowkitAppearance } from "../provider";
import { TRIGGER_KEY } from "../store/editor-store";
import { useCanvasUi, useLabels } from "./canvas-context";
import { NodeHandles } from "./handles";
import { DraftBadge } from "./step-card";

/** The trigger node. */
export type TriggerNode = Node<Record<string, never>, "trigger">;

/** One line describing when a trigger fires. */
function triggerCaption(
  t: TriggerManifest | undefined,
  trigger: WorkflowDoc["trigger"],
  labels: FlowkitLabels,
): string {
  if (!t) return labels.triggerUnknown(trigger.type);
  switch (t.kind) {
    case "event":
      return labels.triggerEvent(t.event || undefined);
    case "webhook":
      return labels.triggerWebhook;
    case "manual":
      return labels.triggerManual;
    case "schedule": {
      const cron = trigger.config.cron;
      return labels.triggerSchedule(typeof cron === "string" && cron ? cron : undefined);
    }
    case "subflow":
      return labels.triggerSubflow;
    default:
      return t.description ?? "";
  }
}

const isTriggerIssue = (i: Issue) =>
  i.stepId === undefined &&
  (i.code === "trigger.unknown" || i.field?.startsWith("trigger.") === true);

/** The workflow's trigger card, at the top of the canvas. */
export const TriggerCard = memo(function TriggerCard({ selected }: NodeProps<TriggerNode>) {
  const { resolveIcon } = useFlowkitAppearance();
  const labels = useLabels();
  // Only the trigger's slice of the store, so edits to steps don't re-render this card.
  const { trigger, docTrigger } = useEditorStore(
    useShallow((s) => ({
      docTrigger: s.doc.trigger,
      trigger: s.manifest.triggers.find((t) => t.type === s.doc.trigger.type),
    })),
  );
  const lastIssues = useRef<Issue[]>([]);
  const issues = useEditorStore((s) => {
    const next = s.issues.filter(isTriggerIssue);
    if (sameIssues(lastIssues.current, next)) return lastIssues.current;
    lastIssues.current = next;
    return next;
  });
  const testState = useEditorStore((s) => s.testState[TRIGGER_KEY]);
  const inRunMode = useCanvasUi((s) => s.overlay !== undefined);
  const Icon = trigger?.icon ? resolveIcon(trigger.icon) : Zap;
  const name = trigger?.name ?? labels.triggerTag;
  return (
    <>
      <NodeHandles />
      <div
        className="fk-card fk-card--trigger"
        data-selected={selected || undefined}
        data-unknown={!trigger || undefined}
      >
        <div className="fk-card__icon" data-tone="trigger" aria-hidden>
          <Icon size={18} />
        </div>
        <div className="fk-card__body">
          <div className="fk-card__title-row">
            <span className="fk-card__title" title={name}>
              {name}
            </span>
          </div>
          <div className="fk-card__summary">{triggerCaption(trigger, docTrigger, labels)}</div>
        </div>
        <span className="fk-card__tag">{labels.triggerTag}</span>
        {!inRunMode && (
          <div className="fk-card__status">
            <DraftBadge issues={issues} testState={testState} />
          </div>
        )}
      </div>
    </>
  );
});
