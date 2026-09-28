import type { Manifest, NodeManifest, RunDetail } from "@flowline/core";
import * as Popover from "@radix-ui/react-popover";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Ban, CircleAlert, CircleStop, Hourglass, LoaderCircle, RotateCcw } from "lucide-react";
import {
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { PortalContainerContext, type RunOverlay } from "../canvas/canvas-context";
import { stepDisplayName } from "../canvas/step-card";
import { WorkflowCanvas } from "../canvas/workflow-canvas";
import { EditorContext, stepIndex, useEditorStore, useRun } from "../hooks";
import { useFlowline, useFlowlineAppearance } from "../provider";
import { createEditorStore, type EditorStore, TRIGGER_KEY } from "../store/editor-store";
import { themeStyle } from "../theme";
import { type NotFoundAction, NotFoundState } from "../ui/not-found";
import { errorText, httpStatus, useNow } from "../ui/primitives";
import { ToasterProvider, useToast } from "../ui/toaster";
import { ResumeDialog } from "./resume-dialog";
import { type ResolvedRun, resolveRun } from "./run-overlay";
import { displayState, isTerminal, RunStateChip } from "./run-status";
import { StepInspector } from "./step-inspector";

/** Loads the manifest once per client; `retry` loads it again after a failure. */
function useManifest(): { manifest?: Manifest; error?: string; retry(): void } {
  const { client } = useFlowline();
  const [state, setState] = useState<{ manifest?: Manifest; error?: string }>({});
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the load.
  useEffect(() => {
    let active = true;
    setState((s) => (s.error ? {} : s));
    client.getManifest().then(
      (manifest) => active && setState({ manifest }),
      (err: unknown) => active && setState({ error: errorText(err) }),
    );
    return () => {
      active = false;
    };
  }, [client, attempt]);
  return { ...state, retry };
}

/** The callback-waiting step of a run, if the run is waiting on one. */
function callbackStep(detail: RunDetail): string | undefined {
  if (detail.run.status !== "waiting") return undefined;
  for (const [path, e] of Object.entries(detail.run.journal)) {
    if (e.status === "suspended" && e.pending?.hasCallback) return path;
  }
  return undefined;
}

/** What a host's `resumeAction` gets for the step a run is waiting on. */
export interface ResumeActionContext {
  /** The run, as last loaded. */
  run: RunDetail;
  /** ID of the waiting step. */
  stepId: string;
  /** Journal path of the waiting step (pass it as `expectStep` when resuming). */
  stepPath: string;
  /** The waiting step's node type; its `resume` says how it expects to be resumed. */
  node: NodeManifest | undefined;
  /** Where the action is rendered: the viewer's header or the waiting step's inspector. */
  placement: "header" | "inspector";
  /** Opens the built-in Resume run dialog. */
  openResumeDialog(): void;
  /** Reloads the run, e.g. after the host resumed it. */
  refresh(): void;
}

/**
 * Replaces RunViewer's Resume… action for a waiting step: `false` hides it everywhere; a function
 * renders your own control instead (return `null` to hide it for some steps).
 */
export type ResumeActionProp = false | ((ctx: ResumeActionContext) => ReactNode);

function RunBody({
  runId,
  detail,
  manifest,
  refresh,
  onRetried,
  resumeAction,
  userName,
}: {
  runId: string;
  detail: RunDetail;
  manifest: Manifest;
  refresh(): void;
  onRetried?(runId: string): void;
  resumeAction?: ResumeActionProp | undefined;
  userName?: ((userId: string) => string | undefined) | undefined;
}) {
  const { labels, resolveIcon } = useFlowlineAppearance();
  const { client } = useFlowline();
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

  // Open the step that needs attention (failed, or waiting) once per run: as soon as there is
  // one, even if the run only fails after it was opened, unless the user picked a step already.
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (focused.current === runId || !resolved.focusStepId) return;
    focused.current = runId;
    if (store.getState().selection === null) store.getState().select(resolved.focusStepId);
  }, [runId, resolved.focusStepId, store]);

  const [busy, setBusy] = useState<"retry" | "cancel" | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const terminal = isTerminal(run.status);
  useEffect(() => {
    if (terminal) setCancelling(false);
  }, [terminal]);
  const state = displayState(run, cancelling);
  const now = useNow(1000, !terminal);
  const waitingPath = callbackStep(detail);

  const retry = async () => {
    setBusy("retry");
    try {
      const { runId: next } = await client.retryRun(run.id);
      toast({ message: labels.retryStarted, tone: "success" });
      // A retry continues the same run: reload it, which also resumes listening to it.
      refresh();
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
      // Only the wait this dialog was opened for: 410 if the run moved on meanwhile.
      await client.resumeRun(run.id, body, waitingPath ? { expectStep: waitingPath } : {});
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
  const stoppedStep =
    state === "stopped" && run.stoppedAt ? stepIdOfEntry(run.stoppedAt) : undefined;
  /** The Stop step's reason, from its journal entry (or the run output). */
  const stopReason = (() => {
    if (!run.stoppedAt) return undefined;
    const out = (run.journal[run.stoppedAt] as { output?: { reason?: unknown } } | undefined)
      ?.output;
    const reason = out?.reason ?? (run.output as { reason?: unknown } | undefined)?.reason;
    return typeof reason === "string" && reason !== "" ? reason : undefined;
  })();
  /** When the Stop step ended the run: its `run.completed` event (or the run's last update). */
  const stoppedTime =
    detail.events.findLast((e) => e.type === "run.completed")?.at ?? run.updatedAt;
  const cancelled = run.status === "cancelled" ? cancellation(detail) : undefined;
  const pending = waitingPath ? detail.run.journal[waitingPath] : undefined;
  const expiresAt = pending?.status === "suspended" ? pending.pending?.expiresAt : undefined;
  const waitingType = waitingStep ? stepIndex(detail.doc).get(waitingStep)?.type : undefined;
  const waitingNode = manifest.nodes.find((n) => n.type === waitingType);
  const resumeSpec = waitingNode?.resume;
  /** Guidance for a wait the host app resumes (the node declares `resume.hostHandled`). */
  const resumeHint = resumeSpec?.hostHandled
    ? (resumeSpec.hint ?? labels.resumeHandledByApp)
    : undefined;
  const canResume = waitingPath !== undefined && waitingStep !== undefined && !cancelling;
  /** The resume control at `placement`: the host's, or Resume… unless the app resumes it. */
  const resumeControl = (placement: "header" | "inspector", small: boolean): ReactNode => {
    if (!canResume || resumeAction === false) return null;
    if (typeof resumeAction === "function") {
      return resumeAction({
        run: detail,
        stepId: waitingStep,
        stepPath: waitingPath,
        node: waitingNode,
        placement,
        openResumeDialog: () => setResumeOpen(true),
        refresh,
      });
    }
    if (resumeSpec?.hostHandled) return null;
    return (
      <button
        type="button"
        className={small ? "fl-btn fl-btn--sm" : "fl-btn"}
        onClick={() => setResumeOpen(true)}
      >
        {labels.resume}
      </button>
    );
  };

  const selection = useStoreSelection(store);
  const duration = (terminal ? run.updatedAt : now) - run.createdAt;
  const canCancel = !terminal && !cancelling;

  return (
    <EditorContext.Provider value={store}>
      <header className="fl-header fl-header--run">
        <div className="fl-header__title">
          <RunStateChip state={state} size="lg" />
          <h1 className="fl-run-title">
            <span className="fl-run-title__name">{detail.doc.name}</span>
            <span className="fl-version">{labels.version(run.version)}</span>
          </h1>
        </div>
        <p className="fl-run-meta">
          <span>
            <span title={labels.dateTime(run.createdAt)}>
              {labels.started(labels.relativeTime(run.createdAt - now))}
            </span>
          </span>
          <span>
            <span className="fl-tabular">{labels.duration(Math.max(0, duration))}</span>
          </span>
          <span>
            <span>{labels.origin(run.startedBy)}</span>
          </span>
        </p>
        <div className="fl-header__actions">
          {resumeControl("header", false)}
          {canCancel && <CancelButton busy={busy} onConfirm={() => void cancel()} />}
          {run.status === "failed" && (
            <button
              type="button"
              className="fl-btn fl-btn--primary"
              aria-disabled={busy !== null || undefined}
              onClick={() => busy === null && void retry()}
            >
              {busy === "retry" ? (
                <LoaderCircle size={14} className="fl-spin" aria-hidden />
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
      {stoppedStep && (
        <Banner
          redundant={selection === stoppedStep}
          tone="neutral"
          icon={<CircleStop size={16} aria-hidden />}
          title={labels.stoppedAt(nameOf(stoppedStep))}
          detail={[stopReason, labels.relativeTime(stoppedTime - now)].filter(Boolean).join(" · ")}
          detailTitle={labels.dateTime(stoppedTime)}
          action={{ label: labels.showStep, run: () => store.getState().select(stoppedStep) }}
        />
      )}
      {cancelled && (
        <Banner
          // The inspector says "Cancelled" but not who or why: keep the banner when it says more.
          redundant={
            cancelled.stepId !== undefined &&
            selection === cancelled.stepId &&
            cancelled.by === undefined &&
            cancelled.reason === undefined
          }
          tone="neutral"
          icon={<Ban size={16} aria-hidden />}
          title={
            cancelled.stepId === undefined
              ? labels.runState.cancelled
              : cancelled.waiting
                ? labels.cancelledWhileWaiting(nameOf(cancelled.stepId))
                : labels.cancelledAt(nameOf(cancelled.stepId))
          }
          detail={[
            cancelled.by !== undefined
              ? labels.cancelledBy(userName?.(cancelled.by) ?? cancelled.by)
              : undefined,
            cancelled.reason,
            labels.relativeTime(cancelled.at - now),
          ]
            .filter(Boolean)
            .join(" · ")}
          detailTitle={labels.dateTime(cancelled.at)}
          {...(cancelled.stepId !== undefined
            ? {
                action: {
                  label: labels.showStep,
                  run: () => store.getState().select(cancelled.stepId as string),
                },
              }
            : {})}
        />
      )}
      {waitingStep && !cancelling && (
        <Banner
          // On narrow screens the inspector already says this while it shows the waiting step.
          redundant={selection === waitingStep}
          tone="warning"
          icon={<Hourglass size={16} aria-hidden />}
          title={nameOf(waitingStep)}
          detail={[
            (resumeSpec?.hostHandled ? labels.waitingForDecision : labels.waitingForCallback)(
              expiresAt !== undefined ? labels.relativeTime(expiresAt - now) : undefined,
            ),
            resumeHint,
          ]
            .filter(Boolean)
            .join(". ")}
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
        {...(canResume
          ? {
              waitingStep,
              resumeSlot: resumeControl("inspector", true),
              ...(resumeHint ? { resumeHint } : {}),
            }
          : {})}
      />
      <ResumeDialog
        open={resumeOpen}
        onOpenChange={setResumeOpen}
        onResume={resume}
        schema={resumeSpec?.body}
      />
    </EditorContext.Provider>
  );
}

/** How a cancelled run was cancelled, from its `run.cancelled` event (or its last update). */
function cancellation(detail: RunDetail): {
  stepId?: string;
  /** The step was waiting (not running) when the run was cancelled. */
  waiting: boolean;
  by?: string;
  reason?: string;
  at: number;
} {
  const { run } = detail;
  const event = detail.events.findLast((e) => e.type === "run.cancelled");
  const data = (event?.data ?? {}) as { by?: unknown; reason?: unknown };
  const path = event?.stepPath;
  const entry =
    path !== undefined && Object.hasOwn(run.journal, path) ? run.journal[path] : undefined;
  return {
    ...(path !== undefined ? { stepId: stepIdOfEntry(path) } : {}),
    waiting: entry?.status === "suspended",
    ...(typeof data.by === "string" && data.by !== "" ? { by: data.by } : {}),
    ...(typeof data.reason === "string" && data.reason !== "" ? { reason: data.reason } : {}),
    at: event?.at ?? run.updatedAt,
  };
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

/** The selection of `store` (RunBody renders above its own EditorContext provider). */
function useStoreSelection(store: EditorStore): string | null {
  const [selection, setSelection] = useState(store.getState().selection);
  useEffect(() => {
    setSelection(store.getState().selection);
    return store.subscribe((s) => setSelection(s.selection));
  }, [store]);
  return selection;
}

/** Cancel run, behind a small confirm: cancelling a live run can't be undone. */
function CancelButton({ busy, onConfirm }: { busy: string | null; onConfirm(): void }) {
  const { labels } = useFlowlineAppearance();
  const container = useContext(PortalContainerContext);
  const [open, setOpen] = useState(false);
  const titleId = useId();
  return (
    <Popover.Root open={open} onOpenChange={(next) => setOpen(next && busy === null)}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="fl-btn fl-btn--danger"
          aria-disabled={busy !== null || undefined}
        >
          {busy === "cancel" && <LoaderCircle size={14} className="fl-spin" aria-hidden />}
          {labels.cancelRun}
        </button>
      </Popover.Trigger>
      <Popover.Portal container={container}>
        <Popover.Content
          className="fl-confirm"
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          aria-labelledby={titleId}
        >
          <p id={titleId} className="fl-confirm__title">
            {labels.cancelRunConfirm}
          </p>
          <p className="fl-confirm__body">{labels.cancelRunConfirmBody}</p>
          <div className="fl-confirm__actions">
            <Popover.Close asChild>
              <button type="button" className="fl-btn fl-btn--sm">
                {labels.keepRunning}
              </button>
            </Popover.Close>
            <button
              type="button"
              className="fl-btn fl-btn--sm fl-btn--danger-solid"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              {labels.cancelRun}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Banner({
  tone,
  icon,
  title,
  detail,
  detailTitle,
  action,
  redundant,
}: {
  /** Hidden on narrow screens, where the inspector repeats it. */
  redundant?: boolean;
  tone: "danger" | "warning" | "neutral";
  icon: ReactNode;
  title: string;
  detail?: string;
  /** Tooltip of the detail line, e.g. the full date of a relative time. */
  detailTitle?: string;
  action?: { label: string; run(): void };
}) {
  return (
    <div
      className="fl-banner"
      data-tone={tone}
      data-redundant={redundant || undefined}
      role={tone === "danger" ? "alert" : "status"}
    >
      <span className="fl-banner__icon">{icon}</span>
      <div className="fl-banner__text">
        <span className="fl-banner__title">{title}</span>
        {detail && (
          <span className="fl-banner__detail" title={detailTitle}>
            {detail}
          </span>
        )}
      </div>
      {action && (
        <button type="button" className="fl-btn fl-btn--sm fl-btn--ghost" onClick={action.run}>
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
  resumeSlot,
  resumeHint,
  waitingStep,
}: {
  store: EditorStore;
  detail: RunDetail;
  resolved: ResolvedRun;
  overlay: RunOverlay;
  nameOf(id: string): string;
  manifest: Manifest;
  resolveIcon(name?: string): React.ComponentType<{ size?: number }>;
  /** The waiting step's resume control (shown in its inspector). */
  resumeSlot?: ReactNode;
  /** Guidance shown in the waiting step's inspector. */
  resumeHint?: string;
  waitingStep?: string;
}) {
  const { labels } = useFlowlineAppearance();
  const selection = useEditorStore((s) => s.selection);
  let name = "";
  let Icon: React.ComponentType<{ size?: number }> | undefined;
  /** The selected step's waits are decided in the host app (e.g. an approval). */
  let decisionWait = false;
  if (selection === TRIGGER_KEY) {
    const t = manifest.triggers.find((x) => x.type === detail.doc.trigger.type);
    name = t?.name ?? labels.triggerTag;
    Icon = t?.icon ? resolveIcon(t.icon) : undefined;
  } else if (selection !== null) {
    name = nameOf(selection);
    const step = stepIndex(detail.doc).get(selection);
    const node = manifest.nodes.find((n) => n.type === step?.type);
    Icon = resolveIcon(node?.icon);
    decisionWait = node?.resume?.hostHandled === true;
  }
  return (
    <div className="fl-editor__body">
      <div className="fl-editor__canvas">
        <WorkflowCanvas store={store} readOnly overlay={overlay} />
      </div>
      {selection !== null && (
        <aside className="fl-panel fl-panel--inspector" aria-label={labels.inspectorTabs}>
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
            decisionWait={decisionWait}
            {...(waitingStep === selection
              ? { resumeSlot, ...(resumeHint ? { resumeHint } : {}) }
              : {})}
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
 * Timeline tabs. Live runs update as their events arrive. Needs a `<FlowlineProvider>` and a sized
 * container.
 *
 * Resume… posts a callback body to the waiting step. When the step's node declares
 * `resume.body`, the dialog starts empty and checks the body against it; when it declares
 * `resume.hostHandled` (e.g. an approval your app decides), the viewer shows its `hint` instead
 * of Resume…. `resumeAction` hides or replaces the action altogether.
 *
 * @example
 * <RunViewer
 *   runId={runId}
 *   onRetried={(next) => navigate(`/runs/${next}`)}
 *   notFoundAction={{ label: "Back to runs", onClick: () => navigate("/runs") }}
 *   resumeAction={({ node }) =>
 *     node?.type === "crm.requestApproval" ? <Link to="/approvals">Open approvals</Link> : null
 *   }
 * />
 */
export function RunViewer(props: {
  runId: string;
  /** Called with the new run's ID after "Retry from failed step". */
  onRetried?(runId: string): void;
  /**
   * The Resume… action of a waiting run: `false` hides it (header and inspector); a function
   * renders your own control in its place, for example a link to where your app resumes it.
   * By default Resume… opens a dialog for the callback body, unless the waiting node declares
   * `resume.hostHandled`.
   */
  resumeAction?: ResumeActionProp;
  /**
   * The action offered when there is no run with this ID (404), e.g. back to your run list.
   * None by default.
   */
  notFoundAction?: NotFoundAction;
  /**
   * The display name of a user ID, e.g. who cancelled the run (the `run.cancelled` event's
   * `data.by`). The ID itself is shown when omitted or when it returns `undefined`.
   */
  userName?(userId: string): string | undefined;
  className?: string;
}): JSX.Element {
  const { runId, onRetried, className, resumeAction, notFoundAction, userName } = props;
  const { theme, labels } = useFlowlineAppearance();
  const { detail, error, refresh } = useRun(runId);
  const { manifest, error: manifestError, retry: retryManifest } = useManifest();
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
        resumeAction={resumeAction}
        userName={userName}
        {...(onRetried ? { onRetried } : {})}
      />
    );
  } else if (error && !detail && httpStatus(error) === 404) {
    content = (
      <NotFoundState
        title={labels.runNotFound}
        detail={labels.runNotFoundDetail(runId)}
        action={notFoundAction}
      />
    );
  } else if ((error && !detail) || manifestError) {
    content = (
      <div className="fl-state" role="alert">
        <p className="fl-state__title">{labels.loadRunFailed}</p>
        <p className="fl-state__detail">{manifestError ?? errorText(error)}</p>
        <button
          type="button"
          className="fl-btn"
          onClick={() => {
            if (manifestError) retryManifest();
            if (error) refresh();
          }}
        >
          {labels.tryAgain}
        </button>
      </div>
    );
  } else {
    content = (
      <div className="fl-state" role="status" aria-busy="true">
        <span className="fl-skeleton" aria-hidden />
        <p className="fl-state__detail">{labels.loadingRun}</p>
      </div>
    );
  }
  return (
    <div
      className={className ? `fl-root fl-app fl-run ${className}` : "fl-root fl-app fl-run"}
      data-fl-theme={theme.colorMode ?? "system"}
      style={style}
    >
      <PortalContainerContext.Provider value={portal}>
        <Tooltip.Provider delayDuration={300} skipDelayDuration={100}>
          <ToasterProvider source="runViewer">{content}</ToasterProvider>
        </Tooltip.Provider>
      </PortalContainerContext.Provider>
      <div ref={setPortal} className="fl-portal" />
    </div>
  );
}
