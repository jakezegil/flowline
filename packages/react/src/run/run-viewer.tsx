import type { Manifest, RunDetail } from "@flowkit/core";
import * as Tooltip from "@radix-ui/react-tooltip";
import { CircleAlert, Hourglass, LoaderCircle, RotateCcw } from "lucide-react";
import { type JSX, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { PortalContainerContext, type RunOverlay } from "../canvas/canvas-context";
import { stepDisplayName } from "../canvas/step-card";
import { WorkflowCanvas } from "../canvas/workflow-canvas";
import { EditorContext, stepIndex, useEditorStore, useRun } from "../hooks";
import { useFlowkit, useFlowkitAppearance } from "../provider";
import { createEditorStore, type EditorStore, TRIGGER_KEY } from "../store/editor-store";
import { themeStyle } from "../theme";
import { errorText, SmallDialog, useNow } from "../ui/primitives";
import { ToasterProvider, useToast } from "../ui/toaster";
import { type ResolvedRun, resolveRun } from "./run-overlay";
import { displayState, isTerminal, RunStateChip } from "./run-status";
import { StepInspector } from "./step-inspector";

/** Loads the manifest once per client. */
function useManifest(): { manifest?: Manifest; error?: string } {
  const { client } = useFlowkit();
  const [state, setState] = useState<{ manifest?: Manifest; error?: string }>({});
  useEffect(() => {
    let active = true;
    client.getManifest().then(
      (manifest) => active && setState({ manifest }),
      (err: unknown) => active && setState({ error: errorText(err) }),
    );
    return () => {
      active = false;
    };
  }, [client]);
  return state;
}

/** The callback-waiting step of a run, if the run is waiting on one. */
function callbackStep(detail: RunDetail): string | undefined {
  if (detail.run.status !== "waiting") return undefined;
  for (const [path, e] of Object.entries(detail.run.journal)) {
    if (e.status === "suspended" && e.pending?.hasCallback) return path;
  }
  return undefined;
}

/** "Resume run": sends a JSON callback body with the authorized resume route. */
function ResumeDialog({
  open,
  onOpenChange,
  onResume,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onResume(body: unknown): Promise<boolean>;
}) {
  const { labels } = useFlowkitAppearance();
  const [text, setText] = useState("{}");
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    let body: unknown;
    try {
      body = text.trim() === "" ? undefined : JSON.parse(text);
    } catch {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setBusy(true);
    const ok = await onResume(body);
    setBusy(false);
    if (ok) onOpenChange(false);
  };
  return (
    <SmallDialog
      open={open}
      onOpenChange={onOpenChange}
      title={labels.resumeTitle}
      description={labels.resumeDescription}
      onSubmit={() => void submit()}
      footer={
        <>
          <button type="button" className="fk-btn" onClick={() => onOpenChange(false)}>
            {labels.cancel}
          </button>
          <button type="submit" className="fk-btn fk-btn--primary" disabled={busy}>
            {busy && <LoaderCircle size={14} className="fk-spin" aria-hidden />}
            {labels.resumeTitle}
          </button>
        </>
      }
    >
      <div className="fk-field">
        <label className="fk-field__label" htmlFor="fk-resume-body">
          {labels.callbackBody}
        </label>
        <textarea
          id="fk-resume-body"
          className="fk-input fk-input--mono"
          rows={6}
          spellCheck={false}
          value={text}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? "fk-resume-err" : undefined}
          onChange={(e) => setText(e.target.value)}
        />
        {invalid && (
          <div id="fk-resume-err" className="fk-field__error">
            {labels.invalidJson}
          </div>
        )}
      </div>
    </SmallDialog>
  );
}

function RunBody({
  runId,
  detail,
  manifest,
  refresh,
  onRetried,
}: {
  runId: string;
  detail: RunDetail;
  manifest: Manifest;
  refresh(): void;
  onRetried?(runId: string): void;
}) {
  const { labels, resolveIcon } = useFlowkitAppearance();
  const { client } = useFlowkit();
  const toast = useToast();
  const { run } = detail;
  const docKey = `${run.id}:${run.version}`;
  // One store per pinned doc; refetches of the same run keep it (and the selection).
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the pinned version, not the refetched object.
  const store = useMemo<EditorStore>(
    () => createEditorStore({ doc: detail.doc, manifest }),
    [docKey, manifest],
  );
  const [iteration, setIteration] = useState<Record<string, number>>({});
  const resolved: ResolvedRun = useMemo(
    () => resolveRun(detail, manifest, iteration),
    [detail, manifest, iteration],
  );
  const overlay: RunOverlay = useMemo(
    () => ({
      ...resolved.overlay,
      onIterationChange: (id, index) => setIteration((it) => ({ ...it, [id]: index })),
    }),
    [resolved],
  );

  // Open the step that needs attention (failed, or waiting) once per run.
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (focused.current === runId) return;
    focused.current = runId;
    if (resolved.focusStepId) store.getState().select(resolved.focusStepId);
  }, [runId, resolved.focusStepId, store]);

  const [busy, setBusy] = useState<"retry" | "cancel" | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const terminal = isTerminal(run.status);
  useEffect(() => {
    if (terminal) setCancelling(false);
  }, [terminal]);
  const state = displayState(run.status, detail.events, cancelling);
  const now = useNow(1000, !terminal);
  const waitingPath = callbackStep(detail);

  const retry = async () => {
    setBusy("retry");
    try {
      const { runId: next } = await client.retryRun(run.id);
      toast({ message: labels.retryStarted, tone: "success" });
      onRetried?.(next);
    } catch (err) {
      toast({ message: labels.retryFailed(errorText(err)), tone: "danger" });
    } finally {
      setBusy(null);
    }
  };
  const cancel = async () => {
    setBusy("cancel");
    try {
      // 202 means cancellation was requested for an executing step: it lands when that step ends.
      await client.cancelRun(run.id);
      setCancelling(true);
      refresh();
    } catch (err) {
      toast({ message: labels.cancelFailed(errorText(err)), tone: "danger" });
    } finally {
      setBusy(null);
    }
  };
  const resume = async (body: unknown) => {
    try {
      await client.resumeRun(run.id, body);
      toast({ message: labels.resumed, tone: "success" });
      refresh();
      return true;
    } catch (err) {
      toast({ message: labels.resumeFailed(errorText(err)), tone: "danger" });
      return false;
    }
  };

  const nameOf = (id: string) => {
    const step = stepIndex(detail.doc).get(id);
    return step
      ? stepDisplayName(
          step,
          manifest.nodes.find((n) => n.type === step.type),
        )
      : id;
  };
  const failedStep = run.status === "failed" ? resolved.focusStepId : undefined;
  const failedIteration = (() => {
    const m = run.error?.stepPath?.match(/body\[(\d+)\]\/[^/]+$/);
    const loop = failedStep ? loopOf(resolved, failedStep) : undefined;
    const count = loop ? resolved.overlay.loopIteration[loop]?.count : undefined;
    return m && count ? labels.iterationOf(Number(m[1]) + 1, count) : undefined;
  })();
  const waitingStep = waitingPath ? stepIdOfEntry(waitingPath) : undefined;
  const pending = waitingPath ? detail.run.journal[waitingPath] : undefined;
  const expiresAt = pending?.status === "suspended" ? pending.pending?.expiresAt : undefined;

  const duration = (terminal ? run.updatedAt : now) - run.createdAt;
  const canCancel = !terminal && !cancelling;

  return (
    <EditorContext.Provider value={store}>
      <header className="fk-header fk-header--run">
        <div className="fk-header__title">
          <RunStateChip state={state} size="lg" />
          <h1 className="fk-run-title">
            <span className="fk-run-title__name">{detail.doc.name}</span>
            <span className="fk-version">{labels.version(run.version)}</span>
          </h1>
        </div>
        <dl className="fk-run-meta">
          <div>
            <dt className="fk-sr-only">{labels.started("")}</dt>
            <dd title={labels.dateTime(run.createdAt)}>
              {labels.started(labels.relativeTime(run.createdAt - now))}
            </dd>
          </div>
          <div>
            <dd className="fk-tabular">{labels.duration(Math.max(0, duration))}</dd>
          </div>
          <div>
            <dd>{labels.origin(run.startedBy)}</dd>
          </div>
        </dl>
        <div className="fk-header__actions">
          {canCancel && (
            <button
              type="button"
              className="fk-btn"
              aria-disabled={busy !== null || undefined}
              onClick={() => busy === null && void cancel()}
            >
              {busy === "cancel" && <LoaderCircle size={14} className="fk-spin" aria-hidden />}
              {labels.cancelRun}
            </button>
          )}
          {waitingPath && !cancelling && (
            <button type="button" className="fk-btn" onClick={() => setResumeOpen(true)}>
              {labels.resume}
            </button>
          )}
          {run.status === "failed" && (
            <button
              type="button"
              className="fk-btn fk-btn--primary"
              aria-disabled={busy !== null || undefined}
              onClick={() => busy === null && void retry()}
            >
              {busy === "retry" ? (
                <LoaderCircle size={14} className="fk-spin" aria-hidden />
              ) : (
                <RotateCcw size={14} aria-hidden />
              )}
              {labels.retryFromFailed}
            </button>
          )}
        </div>
      </header>
      {run.status === "failed" && run.error && (
        <Banner
          tone="danger"
          icon={<CircleAlert size={16} aria-hidden />}
          title={
            failedStep
              ? `${labels.failedAt(nameOf(failedStep))}${failedIteration ? `, ${failedIteration}` : ""}`
              : labels.runState.failed
          }
          detail={run.error.message}
          {...(failedStep
            ? { action: { label: labels.showStep, run: () => store.getState().select(failedStep) } }
            : {})}
        />
      )}
      {waitingStep && !cancelling && (
        <Banner
          tone="warning"
          icon={<Hourglass size={16} aria-hidden />}
          title={nameOf(waitingStep)}
          detail={labels.waitingForCallback(
            expiresAt !== undefined ? labels.relativeTime(expiresAt - now) : undefined,
          )}
          action={{ label: labels.showStep, run: () => store.getState().select(waitingStep) }}
        />
      )}
      <RunCanvasAndInspector
        store={store}
        detail={detail}
        resolved={resolved}
        overlay={overlay}
        nameOf={nameOf}
        manifest={manifest}
        resolveIcon={resolveIcon}
        {...(waitingPath && !cancelling
          ? { onResume: () => setResumeOpen(true), waitingStep }
          : {})}
      />
      <ResumeDialog open={resumeOpen} onOpenChange={setResumeOpen} onResume={resume} />
    </EditorContext.Provider>
  );
}

function stepIdOfEntry(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** The loop step directly enclosing `stepId` in its resolved path, if any. */
function loopOf(resolved: ResolvedRun, stepId: string): string | undefined {
  const path = resolved.paths[stepId];
  const m = path?.match(/(?:^|\/)([^/]+)\/body\[\d+\]\/[^/]+$/);
  return m?.[1];
}

function Banner({
  tone,
  icon,
  title,
  detail,
  action,
}: {
  tone: "danger" | "warning";
  icon: ReactNode;
  title: string;
  detail?: string;
  action?: { label: string; run(): void };
}) {
  return (
    <div className="fk-banner" data-tone={tone} role={tone === "danger" ? "alert" : "status"}>
      <span className="fk-banner__icon">{icon}</span>
      <div className="fk-banner__text">
        <span className="fk-banner__title">{title}</span>
        {detail && <span className="fk-banner__detail">{detail}</span>}
      </div>
      {action && (
        <button type="button" className="fk-btn fk-btn--sm fk-btn--ghost" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}

function RunCanvasAndInspector({
  store,
  detail,
  resolved,
  overlay,
  nameOf,
  manifest,
  resolveIcon,
  onResume,
  waitingStep,
}: {
  store: EditorStore;
  detail: RunDetail;
  resolved: ResolvedRun;
  overlay: RunOverlay;
  nameOf(id: string): string;
  manifest: Manifest;
  resolveIcon(name?: string): React.ComponentType<{ size?: number }>;
  onResume?: () => void;
  waitingStep?: string;
}) {
  const { labels } = useFlowkitAppearance();
  const selection = useEditorStore((s) => s.selection);
  let name = "";
  let Icon: React.ComponentType<{ size?: number }> | undefined;
  if (selection === TRIGGER_KEY) {
    const t = manifest.triggers.find((x) => x.type === detail.doc.trigger.type);
    name = t?.name ?? labels.triggerTag;
    Icon = t?.icon ? resolveIcon(t.icon) : undefined;
  } else if (selection !== null) {
    name = nameOf(selection);
    const step = stepIndex(detail.doc).get(selection);
    Icon = resolveIcon(manifest.nodes.find((n) => n.type === step?.type)?.icon);
  }
  return (
    <div className="fk-editor__body">
      <div className="fk-editor__canvas">
        <WorkflowCanvas store={store} readOnly overlay={overlay} />
      </div>
      {selection !== null && (
        <aside className="fk-panel fk-panel--inspector" aria-label={labels.inspectorTabs}>
          <StepInspector
            // Reset tabs when a different step (or iteration) is inspected.
            key={`${selection}:${resolved.paths[selection] ?? ""}`}
            detail={detail}
            selection={selection}
            path={resolved.paths[selection]}
            overlay={overlay}
            name={name}
            {...(Icon ? { icon: <Icon size={16} /> } : {})}
            onClose={() => store.getState().select(null)}
            {...(onResume && waitingStep === selection ? { onResume } : {})}
          />
        </aside>
      )}
    </div>
  );
}

/**
 * The run and audit view: the workflow's canvas (read-only) painted with the run's step statuses,
 * the path it took and a stepper per loop that opens on the failed iteration; a header with the
 * run's status, version, start time, duration and origin, and Retry from failed step, Cancel run
 * and Resume… actions; and an inspector for the clicked step with Input, Output, Error and
 * Timeline tabs. Live runs update as their events arrive. Needs a `<FlowkitProvider>` and a sized
 * container.
 *
 * @example
 * <RunViewer runId={runId} onRetried={(next) => navigate(`/runs/${next}`)} />
 */
export function RunViewer(props: {
  runId: string;
  /** Called with the new run's ID after "Retry from failed step". */
  onRetried?(runId: string): void;
  className?: string;
}): JSX.Element {
  const { runId, onRetried, className } = props;
  const { theme, labels } = useFlowkitAppearance();
  const { detail, error, refresh } = useRun(runId);
  const { manifest, error: manifestError } = useManifest();
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  const style = useMemo(() => themeStyle(theme.tokens), [theme.tokens]);

  let content: ReactNode;
  if (detail && manifest) {
    content = (
      <RunBody
        key={runId}
        runId={runId}
        detail={detail}
        manifest={manifest}
        refresh={refresh}
        {...(onRetried ? { onRetried } : {})}
      />
    );
  } else if ((error && !detail) || manifestError) {
    content = (
      <div className="fk-state" role="alert">
        <p className="fk-state__title">{labels.loadRunFailed}</p>
        <p className="fk-state__detail">{manifestError ?? errorText(error)}</p>
        <button type="button" className="fk-btn" onClick={refresh}>
          {labels.tryAgain}
        </button>
      </div>
    );
  } else {
    content = (
      <div className="fk-state" role="status" aria-busy="true">
        <span className="fk-skeleton" aria-hidden />
        <p className="fk-state__detail">{labels.loadingRun}</p>
      </div>
    );
  }
  return (
    <div
      className={className ? `fk-root fk-app fk-run ${className}` : "fk-root fk-app fk-run"}
      data-fk-theme={theme.colorMode ?? "system"}
      style={style}
    >
      <PortalContainerContext.Provider value={portal}>
        <Tooltip.Provider delayDuration={300} skipDelayDuration={100}>
          <ToasterProvider>{content}</ToasterProvider>
        </Tooltip.Provider>
      </PortalContainerContext.Provider>
      <div ref={setPortal} className="fk-portal" />
    </div>
  );
}
