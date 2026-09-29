import {
  hiddenFields,
  type Issue,
  type JSONSchema,
  type TriggerManifest,
  type WorkflowDoc,
} from "@flowlinejs/core";
import type { Node, NodeProps } from "@xyflow/react";
import { Zap } from "lucide-react";
import { memo, useRef } from "react";
import { sameIssues, useEditorStore, useShallow } from "../hooks";
import type { FlowlineLabels } from "../labels";
import { labelOf, metaOf, optionLabel } from "../panel/schema";
import { useFlowlineAppearance } from "../provider";
import { TRIGGER_KEY } from "../store/editor-store";
import { useCanvasUi, useLabels } from "./canvas-context";
import { NodeHandles } from "./handles";
import { DraftBadge } from "./step-card";

/** The trigger node. */
export type TriggerNode = Node<Record<string, never>, "trigger">;

/** Longest filter value shown on the trigger card. */
const MAX_FILTER = 24;

/**
 * An event trigger's set, visible config values ("Stage: Won · Min amount: 5000"), so filters show
 * on the card; references and objects are left to the panel.
 */
function triggerFilters(
  t: TriggerManifest | undefined,
  trigger: WorkflowDoc["trigger"],
  labels: FlowlineLabels,
): string[] {
  const schema = t?.config as JSONSchema | undefined;
  const props = (schema?.properties ?? {}) as Record<string, JSONSchema>;
  // Only an event trigger's config filters which events start a run.
  if (!schema || t?.kind !== "event") return [];
  const hidden = hiddenFields(trigger.config, schema);
  const out: string[] = [];
  for (const [key, field] of Object.entries(props)) {
    const value = trigger.config[key];
    if (hidden.has(key) || value === undefined || value === null || value === "") continue;
    const primitive = (v: unknown) => typeof v !== "object" || v === null;
    if (Array.isArray(value) ? !value.every(primitive) || value.length === 0 : !primitive(value))
      continue;
    const meta = metaOf(field);
    if (meta.secret || meta.sensitive || value === false) continue;
    // A switch that's on reads as its label ("Only when the stage changes").
    if (value === true) {
      out.push(labelOf(field, key));
      continue;
    }
    const text = Array.isArray(value)
      ? value.map((v) => optionLabel(v, meta)).join(", ")
      : optionLabel(value, meta);
    const short = text.length > MAX_FILTER ? `${text.slice(0, MAX_FILTER - 1)}…` : text;
    out.push(labels.triggerFilter(labelOf(field, key), short));
  }
  return out;
}

/** One line describing when a trigger fires. */
function triggerCaption(
  t: TriggerManifest | undefined,
  trigger: WorkflowDoc["trigger"],
  labels: FlowlineLabels,
): string {
  if (!t) return labels.triggerUnknown(trigger.type);
  switch (t.kind) {
    case "event":
      return t.events && t.events.length > 0
        ? labels.triggerEvents(t.events)
        : labels.triggerEvent(t.event || undefined);
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
    case "poll":
      // Absent: the engine's `poll.defaultInterval` ("1m") applies (§7.1 of the design spec).
      return labels.triggerPoll(t.interval ?? 60_000);
    default:
      // Exhaustiveness guard: a future TriggerKind here fails typecheck.
      return t.kind satisfies never;
  }
}

/** Issues shown on the trigger: its own, and the output mapping's (edited in its panel). */
const isTriggerIssue = (i: Issue) =>
  i.stepId === undefined &&
  (i.code === "trigger.unknown" ||
    i.field?.startsWith("trigger.") === true ||
    i.field?.startsWith("output.") === true);

/** The workflow's trigger card, at the top of the canvas. */
export const TriggerCard = memo(function TriggerCard({ selected }: NodeProps<TriggerNode>) {
  const { resolveIcon } = useFlowlineAppearance();
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
  const caption = [
    triggerCaption(trigger, docTrigger, labels),
    ...triggerFilters(trigger, docTrigger, labels),
  ].join(" · ");
  return (
    <>
      <NodeHandles />
      <div
        className="fl-card fl-card--trigger"
        data-selected={selected || undefined}
        data-unknown={!trigger || undefined}
      >
        <div className="fl-card__icon" data-tone="trigger" aria-hidden>
          <Icon size={18} />
        </div>
        <div className="fl-card__body">
          <div className="fl-card__title-row">
            <span className="fl-card__title" title={name}>
              {name}
            </span>
          </div>
          <div className="fl-card__summary" title={caption}>
            {caption}
          </div>
        </div>
        <span className="fl-card__tag">{labels.triggerTag}</span>
        {!inRunMode && (
          <div className="fl-card__status">
            <DraftBadge issues={issues} testState={testState} />
          </div>
        )}
      </div>
    </>
  );
});
