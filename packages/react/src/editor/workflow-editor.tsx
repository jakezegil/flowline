import type { ValidationContext, WorkflowDoc } from "@flowline/core";
import * as Tooltip from "@radix-ui/react-tooltip";
import { type JSX, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { PortalContainerContext } from "../canvas/canvas-context";
import { focusedKey } from "../canvas/keyboard";
import { WorkflowCanvas } from "../canvas/workflow-canvas";
import { EditorContext, useEditorStore } from "../hooks";
import { ConfigPanel } from "../panel/config-panel";
import { useFlowlineAppearance } from "../provider";
import type { EditorStore } from "../store/editor-store";
import { themeStyle } from "../theme";
import { NotFoundState } from "../ui/not-found";
import { ToasterProvider } from "../ui/toaster";
import { type EditorNotFoundAction, notFoundActionFor, useEditorLoad } from "./editor-load";
import { EditorHeader } from "./header";

export { blankDoc } from "./editor-load";

/**
 * Warns before leaving the page while there are unsaved changes, and tells the host whenever
 * that changes (for its own router's guard).
 */
function useUnsavedGuard(
  store: EditorStore,
  onDirtyChange: ((dirty: boolean) => void) | undefined,
) {
  const dirty = useEditorStore((s) => s.dirty);
  const notify = useRef(onDirtyChange);
  notify.current = onDirtyChange;
  useEffect(() => {
    notify.current?.(dirty);
  }, [dirty]);
  // Unmounting (leaving the editor) leaves nothing unsaved behind to guard.
  useEffect(() => () => notify.current?.(false), []);
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!store.getState().dirty) return;
      e.preventDefault();
      // Older browsers need returnValue set to show the prompt.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty, store]);
}

function EditorBody({
  store,
  renderPanel,
  onDirtyChange,
}: {
  store: EditorStore;
  renderPanel?: (store: EditorStore) => ReactNode;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { labels } = useFlowlineAppearance();
  const selection = useEditorStore((s) => s.selection);
  useUnsavedGuard(store, onDirtyChange);
  return (
    <div className="fl-editor__body">
      <div
        className="fl-editor__canvas"
        onKeyDownCapture={(e) => {
          // Enter or Space on a canvas card opens its panel: move focus there so the keyboard
          // follows.
          if ((e.key !== "Enter" && e.key !== " ") || e.metaKey || e.ctrlKey || e.altKey) return;
          const target = e.target as HTMLElement;
          if (target.closest("button, input, textarea, select, [contenteditable='true']")) return;
          if (focusedKey(target) === undefined && store.getState().selection === null) return;
          const body = e.currentTarget.parentElement;
          requestAnimationFrame(() =>
            body?.querySelector<HTMLElement>(".fl-panel [data-autofocus]")?.focus(),
          );
        }}
      >
        <WorkflowCanvas store={store} />
      </div>
      {selection !== null && (
        <aside className="fl-panel" aria-label={labels.stepSettings}>
          {renderPanel ? renderPanel(store) : <ConfigPanel store={store} />}
        </aside>
      )}
    </div>
  );
}

/**
 * The complete workflow editor: a header (name, save status, undo/redo, issues, Save, Run,
 * Publish), the canvas, and a side panel for the selected step that hides when nothing is
 * selected. Needs a `<FlowlineProvider>` above it and a sized container.
 *
 * Loads the manifest, callable sub-flows and the workflow by ID. A workflow that doesn't exist
 * starts from `initialDoc` if given, else shows "Workflow not found" with `notFoundAction`. Pass
 * `create` for a new workflow: it isn't fetched, starts from `initialDoc` (or a blank manual
 * workflow) and is created by its first save, which never overwrites an existing workflow (it
 * fails with "already exists" instead).
 *
 * Leaving the page (reload, closing the tab) with unsaved changes asks the browser to confirm.
 * Navigation inside your app is yours to guard: `onDirtyChange` says when there are unsaved
 * changes, so your router can block leaving until the user confirms (see the example).
 *
 * @example
 * <div style={{ height: "100vh" }}>
 *   <WorkflowEditor
 *     workflowId="welcome"
 *     headerLeft={<a href="/workflows">Back</a>}
 *     onRunStarted={(runId) => navigate(`/runs/${runId}`)}
 *   />
 * </div>
 *
 * @example
 * // Guarding in-app navigation with React Router (a data router, for `useBlocker`):
 * const [dirty, setDirty] = useState(false);
 * const blocker = useBlocker(dirty);
 * return (
 *   <>
 *     <WorkflowEditor workflowId={id} onDirtyChange={setDirty} />
 *     {blocker.state === "blocked" && (
 *       <ConfirmDialog
 *         title="Leave without saving?"
 *         onConfirm={() => blocker.proceed()}
 *         onCancel={() => blocker.reset()}
 *       />
 *     )}
 *   </>
 * );
 */
export function WorkflowEditor(props: {
  workflowId: string;
  /** Starting doc when the workflow doesn't exist on the server yet. */
  initialDoc?: WorkflowDoc;
  /**
   * A new workflow: don't load it (no request for an ID that isn't there yet), start a draft
   * from `initialDoc` or a blank manual workflow. The first save creates it, only if the ID is
   * still free: it never overwrites an existing workflow.
   */
  create?: boolean;
  /**
   * The action offered when the workflow doesn't exist (and there is no `initialDoc`): your own
   * (e.g. back to your list), `"create"` for "Create this workflow" (a new draft under this ID;
   * only where a mistyped ID can't be the cause), or `null` for none. By default "Go back" (the
   * browser's previous page), when there is one.
   */
  notFoundAction?: EditorNotFoundAction;
  /**
   * The engine's outbound network policy (its `http` settings), so URL fields warn about the
   * hosts it will block, as publishing does. By default private and loopback hosts warn. Read
   * once per load.
   */
  network?: ValidationContext["network"];
  /** Called after a successful publish with the published version. */
  onPublish?(version: number): void;
  /** Called after every successful save with the new version. */
  onSaved?(version: number): void;
  /** Called with the new run's ID after "Run" starts one. */
  onRunStarted?(runId: string): void;
  /**
   * Called whenever the editor gains or loses unsaved changes (edits since the last save), and
   * with `false` when it unmounts. Use it to guard your app's own navigation: block route
   * changes while it's `true` and ask the user to confirm (the editor already guards reloads
   * and closing the tab with `beforeunload`).
   */
  onDirtyChange?(dirty: boolean): void;
  /** Rendered at the start of the header, e.g. a back link. */
  headerLeft?: ReactNode;
  /**
   * Renders the side panel of the selected step (shown only while something is selected). By
   * default {@link ConfigPanel}: the generated config form and the step test.
   */
  renderPanel?: (store: EditorStore) => ReactNode;
  className?: string;
}): JSX.Element {
  const { workflowId, initialDoc, className, headerLeft, renderPanel } = props;
  const { theme, labels } = useFlowlineAppearance();
  const { state, retry, startNew } = useEditorLoad(
    workflowId,
    initialDoc,
    props.create,
    props.network,
  );
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  const style = useMemo(() => themeStyle(theme.tokens), [theme.tokens]);
  const callbacks = {
    ...(props.onPublish ? { onPublish: props.onPublish } : {}),
    ...(props.onSaved ? { onSaved: props.onSaved } : {}),
    ...(props.onRunStarted ? { onRunStarted: props.onRunStarted } : {}),
  };

  let content: ReactNode;
  if (state.status === "ready") {
    content = (
      <EditorContext.Provider value={state.store}>
        <EditorHeader headerLeft={headerLeft} callbacks={callbacks} />
        <EditorBody
          store={state.store}
          {...(renderPanel ? { renderPanel } : {})}
          {...(props.onDirtyChange ? { onDirtyChange: props.onDirtyChange } : {})}
        />
      </EditorContext.Provider>
    );
  } else if (state.status === "notFound") {
    content = (
      <NotFoundState
        title={labels.workflowNotFound}
        detail={labels.workflowNotFoundDetail(workflowId)}
        action={notFoundActionFor(props.notFoundAction, labels, startNew)}
      />
    );
  } else if (state.status === "error") {
    content = (
      <div className="fl-state" role="alert">
        <p className="fl-state__title">{labels.loadWorkflowFailed}</p>
        <p className="fl-state__detail">{state.message}</p>
        <button type="button" className="fl-btn" onClick={retry}>
          {labels.tryAgain}
        </button>
      </div>
    );
  } else {
    content = (
      <div className="fl-state" role="status" aria-busy="true">
        <span className="fl-skeleton" aria-hidden />
        <p className="fl-state__detail">{labels.loadingWorkflow}</p>
      </div>
    );
  }

  return (
    <div
      className={className ? `fl-root fl-app fl-editor ${className}` : "fl-root fl-app fl-editor"}
      data-fl-theme={theme.colorMode ?? "system"}
      style={style}
    >
      <PortalContainerContext.Provider value={portal}>
        <Tooltip.Provider delayDuration={300} skipDelayDuration={100}>
          <ToasterProvider>{content}</ToasterProvider>
        </Tooltip.Provider>
      </PortalContainerContext.Provider>
      <div ref={setPortal} className="fl-portal" />
    </div>
  );
}
