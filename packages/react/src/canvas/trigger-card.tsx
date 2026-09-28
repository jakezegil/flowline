import type { Issue, TriggerManifest, WorkflowDoc } from "@flowkit/core";
import type { Node, NodeProps } from "@xyflow/react";
import { Zap } from "lucide-react";
import { memo, useMemo } from "react";
import { useEditorStore, useShallow } from "../hooks";
import { useFlowkitAppearance } from "../provider";
import { TRIGGER_KEY } from "../store/editor-store";
import { useCanvasUi } from "./canvas-context";
import { NodeHandles } from "./handles";
import { DraftBadge } from "./step-card";

/** The trigger node. */
export type TriggerNode = Node<Record<string, never>, "trigger">;

/** One line describing when a trigger fires. */
function triggerCaption(t: TriggerManifest | undefined, doc: WorkflowDoc): string {
  if (!t) return `Unknown trigger type ${doc.trigger.type}`;
  switch (t.kind) {
    case "event":
      return t.event ? `When ${t.event} happens` : "When an event happens";
    case "webhook":
      return "When a webhook is called";
    case "manual":
      return "When run manually";
    case "schedule": {
      const cron = doc.trigger.config.cron;
      return typeof cron === "string" && cron ? `On schedule ${cron}` : "On a schedule";
    }
    case "subflow":
      return "When called by another workflow";
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
  const { trigger, doc, allIssues } = useEditorStore(
    useShallow((s) => ({
      doc: s.doc,
      trigger: s.manifest.triggers.find((t) => t.type === s.doc.trigger.type),
      allIssues: s.issues,
    })),
  );
  const testState = useEditorStore((s) => s.testState[TRIGGER_KEY]);
  const inRunMode = useCanvasUi((s) => s.overlay !== undefined);
  const issues = useMemo(() => allIssues.filter(isTriggerIssue), [allIssues]);
  const Icon = trigger?.icon ? resolveIcon(trigger.icon) : Zap;
  const name = trigger?.name ?? "Trigger";
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
          <div className="fk-card__summary">{triggerCaption(trigger, doc)}</div>
        </div>
        <span className="fk-card__tag">Trigger</span>
        {!inRunMode && (
          <div className="fk-card__status">
            <DraftBadge issues={issues} testState={testState} />
          </div>
        )}
      </div>
    </>
  );
});
