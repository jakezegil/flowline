import type { JournalEntry, RunDetail, RunEvent, Step } from "@flowkit/core";
import { Hourglass, Play, X, Zap } from "lucide-react";
import { type JSX, type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import type { RunOverlay } from "../canvas/canvas-context";
import { stepIndex } from "../hooks";
import type { FlowkitLabels } from "../labels";
import { useFlowkitAppearance } from "../provider";
import { TRIGGER_KEY } from "../store/editor-store";
import { JsonTree } from "../ui/json-tree";
import { useNow } from "../ui/primitives";
import { stepIdOfPath } from "./run-overlay";

type Tab = "input" | "output" | "error" | "timeline";
const TABS: Tab[] = ["input", "output", "error", "timeline"];

/** What the inspector shows for the selected step (or the trigger / whole run). */
interface Inspected {
  title: string;
  icon: ReactNode;
  entry?: JournalEntry;
  input?: unknown;
  output?: unknown;
  error?: { message: string; code?: string; fatal?: boolean };
  events: RunEvent[];
  /** Where it is in a loop: "iteration 2 of 3". */
  iteration?: string;
  isTrigger: boolean;
}

const has = (v: unknown) => v !== undefined;

/** The innermost loop iteration of a journal path, e.g. `each/body[1]/tag` → each, 1. */
function innermostIteration(path: string): { loopId: string; index: number } | undefined {
  const re = /([^/]+)\/body\[(\d+)\]\//g;
  let last: { loopId: string; index: number } | undefined;
  for (let m = re.exec(path); m; m = re.exec(path)) {
    last = { loopId: stepIdOfPath(m[1] as string), index: Number(m[2]) };
  }
  return last;
}

function inspect(
  detail: RunDetail,
  key: string,
  path: string | undefined,
  overlay: RunOverlay,
  labels: FlowkitLabels,
  names: { step?: Step; name: string; icon: ReactNode },
): Inspected {
  const { run, events } = detail;
  if (key === TRIGGER_KEY) {
    return {
      title: names.name,
      icon: names.icon,
      input: run.trigger,
      output: run.output,
      ...(run.error ? { error: run.error } : {}),
      events,
      isTrigger: true,
    };
  }
  const entry =
    path !== undefined && Object.hasOwn(run.journal, path) ? run.journal[path] : undefined;
  const stepEvents = path === undefined ? [] : events.filter((e) => e.stepPath === path);
  const started = stepEvents.find((e) => e.type === "step.started")?.data as
    | { input?: unknown }
    | undefined;
  const completed = stepEvents.findLast((e) => e.type === "step.completed")?.data as
    | { output?: unknown }
    | undefined;
  let output: unknown;
  if (entry?.status === "done" || entry?.status === "branched") output = entry.output;
  else if (entry?.status === "looping")
    output = { count: entry.items.length, results: entry.results };
  else output = completed?.output;
  let error: Inspected["error"];
  if (entry?.status === "failed") error = entry.error;
  else if (run.error && run.error.stepPath === path) error = run.error;
  const input = entry && "input" in entry && has(entry.input) ? entry.input : started?.input;
  const iter = path ? innermostIteration(path) : undefined;
  const count = iter ? overlay.loopIteration[iter.loopId]?.count : undefined;
  return {
    title: names.name,
    icon: names.icon,
    ...(entry ? { entry } : {}),
    input,
    output,
    ...(error ? { error } : {}),
    events: stepEvents,
    ...(iter && count ? { iteration: labels.iterationOf(iter.index + 1, count) } : {}),
    isTrigger: false,
  };
}

/** One-line description of an audit event. */
function eventDetail(e: RunEvent, labels: FlowkitLabels, now: number): string | undefined {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const err = d.error as { message?: string } | string | undefined;
  const message = typeof err === "string" ? err : err?.message;
  switch (e.type) {
    case "step.retrying":
      return [
        typeof d.attempt === "number"
          ? labels.retryAttempt(d.attempt, typeof d.delayMs === "number" ? d.delayMs : undefined)
          : undefined,
        message,
      ]
        .filter(Boolean)
        .join(" · ");
    case "step.failed":
    case "run.failed":
      return message;
    case "step.completed":
      return typeof d.branch === "string" ? labels.tookBranch(d.branch) : undefined;
    case "run.suspended":
      if (d.callback === true) {
        const exp = typeof d.expiresAt === "number" ? d.expiresAt : undefined;
        return labels.waitingForCallback(exp ? labels.relativeTime(exp - now) : undefined);
      }
      if (typeof d.until === "number") return labels.waitingUntil(labels.dateTime(d.until));
      if (typeof d.childRunId === "string") return labels.waitingForSubflow;
      return undefined;
    default:
      return undefined;
  }
}

const EVENT_TONE: Partial<Record<RunEvent["type"], string>> = {
  "step.completed": "success",
  "run.completed": "success",
  "step.failed": "danger",
  "run.failed": "danger",
  "step.retrying": "warning",
  "run.suspended": "warning",
  "run.cancelled": "muted",
  "run.stopped": "muted",
  "step.skipped": "muted",
};

/** The audit trail as a vertical timeline, times relative to the run's start. */
function Timeline({
  events,
  runStart,
  showSteps,
  stepName,
}: {
  events: RunEvent[];
  runStart: number;
  showSteps: boolean;
  stepName(path: string): string;
}) {
  const { labels } = useFlowkitAppearance();
  const now = useNow(30_000);
  if (events.length === 0) return <p className="fk-empty">{labels.noEvents}</p>;
  return (
    <ol className="fk-timeline">
      {events.map((e) => {
        const detail = eventDetail(e, labels, now);
        const hasData = e.data !== undefined && e.data !== null;
        const head = (
          <>
            <span className="fk-timeline__type">{labels.eventType[e.type]}</span>
            {showSteps && e.stepPath && (
              <span className="fk-timeline__step">{stepName(e.stepPath)}</span>
            )}
            <time
              className="fk-timeline__time"
              dateTime={new Date(e.at).toISOString()}
              title={labels.dateTime(e.at)}
            >
              +{labels.duration(Math.max(0, e.at - runStart))}
            </time>
          </>
        );
        return (
          <li key={e.seq} className="fk-timeline__item" data-tone={EVENT_TONE[e.type] ?? "neutral"}>
            <span className="fk-timeline__dot" aria-hidden />
            <div className="fk-timeline__content">
              {hasData ? (
                <details className="fk-timeline__details">
                  <summary className="fk-timeline__head">{head}</summary>
                  {detail && <div className="fk-timeline__detail">{detail}</div>}
                  <JsonTree value={e.data} />
                </details>
              ) : (
                <div className="fk-timeline__head">{head}</div>
              )}
              {hasData && detail && (
                <div className="fk-timeline__detail fk-timeline__detail--peek">{detail}</div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** The step's status line: status, duration, attempts, iteration. */
function StatusLine({
  status,
  iteration,
}: {
  status: RunOverlay["stepStatus"][string] | undefined;
  iteration?: string;
}) {
  const { labels } = useFlowkitAppearance();
  if (!status) return null;
  const parts = [labels.runStatus[status.status]];
  if (status.durationMs !== undefined) parts.push(labels.duration(status.durationMs));
  if (status.attempts !== undefined && status.attempts > 1)
    parts.push(labels.attempts(status.attempts));
  return (
    <div className="fk-inspector__status" data-status={status.status}>
      <span className="fk-inspector__dot" aria-hidden />
      <span>{parts.join(" · ")}</span>
      {iteration && <span className="fk-inspector__iter">{iteration}</span>}
    </div>
  );
}

/**
 * The side panel of the run viewer for one step (or the trigger): its status, a waiting notice
 * with Resume… for callbacks, and Input / Output / Error / Timeline tabs.
 */
export function StepInspector({
  detail,
  selection,
  path,
  overlay,
  name,
  icon,
  onClose,
  onResume,
}: {
  detail: RunDetail;
  selection: string;
  path: string | undefined;
  overlay: RunOverlay;
  name: string;
  icon?: ReactNode;
  onClose(): void;
  /** Present when the run is waiting on this step's callback. */
  onResume?: () => void;
}): JSX.Element {
  const { labels } = useFlowkitAppearance();
  const now = useNow(30_000);
  const step = stepIndex(detail.doc).get(selection);
  const info = inspect(detail, selection, path, overlay, labels, {
    ...(step ? { step } : {}),
    name,
    icon: icon ?? (selection === TRIGGER_KEY ? <Zap size={16} /> : <Play size={16} />),
  });
  const status = selection === TRIGGER_KEY ? undefined : overlay.stepStatus[selection];
  const dimmed = overlay.dimmedSteps?.has(selection) ?? false;
  const [tab, setTab] = useState<Tab>(() =>
    info.error && (status?.status === "failed" || info.isTrigger)
      ? "error"
      : has(info.output) && !info.isTrigger
        ? "output"
        : info.isTrigger
          ? "input"
          : status?.status === "waiting"
            ? "timeline"
            : "input",
  );
  const id = useId();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const tabName: Record<Tab, string> = {
    input: info.isTrigger ? labels.triggerInput : labels.tabInput,
    output: info.isTrigger ? labels.runOutput : labels.tabOutput,
    error: labels.tabError,
    timeline: labels.tabTimeline,
  };
  const onTabKey = (e: KeyboardEvent) => {
    const i = TABS.indexOf(tab);
    let next: Tab | undefined;
    if (e.key === "ArrowRight") next = TABS[(i + 1) % TABS.length];
    else if (e.key === "ArrowLeft") next = TABS[(i + TABS.length - 1) % TABS.length];
    else if (e.key === "Home") next = TABS[0];
    else if (e.key === "End") next = TABS[TABS.length - 1];
    if (!next) return;
    e.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  const pending =
    info.entry?.status === "suspended" && detail.run.status === "waiting"
      ? info.entry.pending
      : undefined;
  let waiting: string | undefined;
  if (pending?.hasCallback) {
    waiting = labels.waitingForCallback(
      pending.expiresAt !== undefined ? labels.relativeTime(pending.expiresAt - now) : undefined,
    );
  } else if (pending?.until !== undefined) {
    waiting = labels.waitingUntil(labels.relativeTime(pending.until - now));
  } else if (pending?.childRunId !== undefined) {
    waiting = labels.waitingForSubflow;
  }

  const stepName = (p: string) => {
    const s = stepIndex(detail.doc).get(stepIdOfPath(p));
    return s?.name ?? s?.id ?? p;
  };

  let body: ReactNode;
  if (tab === "input") {
    body = has(info.input) ? (
      <JsonTree value={info.input} label={tabName.input} />
    ) : (
      <p className="fk-empty">{dimmed ? labels.notTaken : labels.noInput}</p>
    );
  } else if (tab === "output") {
    body = has(info.output) ? (
      <JsonTree value={info.output} label={tabName.output} />
    ) : (
      <p className="fk-empty">
        {dimmed ? labels.notTaken : status?.status === "pending" ? labels.notRun : labels.noOutput}
      </p>
    );
  } else if (tab === "error") {
    body = info.error ? (
      <div className="fk-error-box">
        <p className="fk-error-box__message">{info.error.message}</p>
        {info.error.code && (
          <p className="fk-error-box__meta">
            {labels.errorCode} <code>{info.error.code}</code>
          </p>
        )}
      </div>
    ) : (
      <p className="fk-empty">{labels.noError}</p>
    );
  } else {
    body = (
      <Timeline
        events={info.events}
        runStart={detail.run.createdAt}
        showSteps={info.isTrigger}
        stepName={stepName}
      />
    );
  }

  return (
    <div className="fk-inspector">
      <div className="fk-panel__head">
        <div className="fk-inspector__icon" aria-hidden>
          {info.icon}
        </div>
        <div className="fk-inspector__heading">
          <h2 className="fk-panel__title">{info.title}</h2>
          <StatusLine status={status} {...(info.iteration ? { iteration: info.iteration } : {})} />
        </div>
        <button
          type="button"
          className="fk-icon-btn"
          aria-label={labels.closePanel}
          onClick={onClose}
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      {waiting && (
        <div className="fk-callout" data-tone="warning">
          <Hourglass size={14} aria-hidden />
          <span className="fk-callout__text">{waiting}</span>
          {onResume && pending?.hasCallback && (
            <button type="button" className="fk-btn fk-btn--sm" onClick={onResume}>
              {labels.resume}
            </button>
          )}
        </div>
      )}
      {dimmed && (
        <p className="fk-callout" data-tone="muted">
          {labels.notTaken}
        </p>
      )}
      <div
        className="fk-tabs"
        role="tablist"
        aria-label={labels.inspectorTabs}
        onKeyDown={onTabKey}
      >
        {TABS.map((t) => (
          <button
            key={t}
            ref={(el) => {
              tabRefs.current[t] = el;
            }}
            type="button"
            role="tab"
            id={`${id}-${t}`}
            aria-selected={tab === t}
            aria-controls={`${id}-panel`}
            tabIndex={tab === t ? 0 : -1}
            className="fk-tab"
            data-alert={(t === "error" && info.error !== undefined) || undefined}
            onClick={() => setTab(t)}
          >
            {tabName[t]}
            {t === "timeline" && info.events.length > 0 && (
              <span className="fk-tab__count">{info.events.length}</span>
            )}
          </button>
        ))}
      </div>
      <div
        className="fk-inspector__body"
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${tab}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable tab panel must be reachable by keyboard.
        tabIndex={0}
      >
        {body}
      </div>
    </div>
  );
}
