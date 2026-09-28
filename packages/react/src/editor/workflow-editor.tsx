import type { WorkflowDoc } from "@flowkit/core";
import * as Tooltip from "@radix-ui/react-tooltip";
import { TriangleAlert, X } from "lucide-react";
import { type JSX, type ReactNode, useEffect, useMemo, useState } from "react";
import { PortalContainerContext } from "../canvas/canvas-context";
import { WorkflowCanvas } from "../canvas/workflow-canvas";
import { EditorContext, useEditorStore, useStep } from "../hooks";
import { useFlowkitAppearance } from "../provider";
import { type EditorStore, TRIGGER_KEY } from "../store/editor-store";
import { themeStyle } from "../theme";
import { type NotFoundAction, NotFoundState } from "../ui/not-found";
import { ToasterProvider } from "../ui/toaster";
import { useEditorLoad } from "./editor-load";
import { EditorHeader } from "./header";

export { blankDoc } from "./editor-load";

/** Warns before leaving the page while there are unsaved changes. */
function useUnsavedGuard(store: EditorStore) {
  const dirty = useEditorStore((s) => s.dirty);
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

/** Placeholder of the side panel until a configuration panel is plugged in. */
function PanelPlaceholder({ selection }: { selection: string }) {
  const { labels } = useFlowkitAppearance();
  const select = useEditorStore((s) => s.select);
  const info = useStep(selection);
  const trigger = useEditorStore((s) =>
    selection === TRIGGER_KEY
      ? s.manifest.triggers.find((t) => t.type === s.doc.trigger.type)
      : undefined,
  );
  const title =
    selection === TRIGGER_KEY
      ? (trigger?.name ?? labels.triggerTag)
      : (info?.step.name ?? info?.manifest?.name ?? selection);
  return (
    <div className="fk-panel__inner">
      <div className="fk-panel__head">
        <div className="fk-panel__title">{title}</div>
        <button
          type="button"
          className="fk-icon-btn"
          aria-label={labels.closePanel}
          onClick={() => select(null)}
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      <div className="fk-panel__body">
        {info && info.issues.length > 0 && (
          <ul className="fk-issue-list">
            {info.issues.map((i) => (
              <li key={`${i.code}:${i.field ?? ""}:${i.message}`} data-severity={i.severity}>
                <TriangleAlert size={13} aria-hidden />
                <span>{i.message}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="fk-panel__empty">{labels.panelPlaceholder}</p>
      </div>
    </div>
  );
}

function EditorBody({
  store,
  renderPanel,
}: {
  store: EditorStore;
  renderPanel?: (store: EditorStore) => ReactNode;
}) {
  const { labels } = useFlowkitAppearance();
  const selection = useEditorStore((s) => s.selection);
  useUnsavedGuard(store);
  return (
    <div className="fk-editor__body">
      <div className="fk-editor__canvas">
        <WorkflowCanvas store={store} />
      </div>
      {selection !== null && (
        <aside className="fk-panel" aria-label={labels.stepSettings}>
          {renderPanel ? renderPanel(store) : <PanelPlaceholder selection={selection} />}
        </aside>
      )}
    </div>
  );
}

/**
 * The complete workflow editor: a header (name, save status, undo/redo, issues, Save, Run,
 * Publish), the canvas, and a side panel for the selected step that hides when nothing is
 * selected. Needs a `<FlowkitProvider>` above it and a sized container.
 *
 * Loads the manifest, callable sub-flows and the workflow by ID. A workflow that doesn't exist
 * starts from `initialDoc` if given, else shows "Workflow not found" with `notFoundAction`. Pass
 * `create` for a new workflow: it isn't fetched, starts from `initialDoc` (or a blank manual
 * workflow) and is created by its first save.
 *
 * @example
 * <div style={{ height: "100vh" }}>
 *   <WorkflowEditor
 *     workflowId="welcome"
 *     headerLeft={<a href="/workflows">Back</a>}
 *     onRunStarted={(runId) => navigate(`/runs/${runId}`)}
 *   />
 * </div>
 */
export function WorkflowEditor(props: {
  workflowId: string;
  /** Starting doc when the workflow doesn't exist on the server yet. */
  initialDoc?: WorkflowDoc;
  /**
   * A new workflow: don't load it (no request for an ID that isn't there yet), start a draft
   * from `initialDoc` or a blank manual workflow. The first save creates it.
   */
  create?: boolean;
  /**
   * The action offered when the workflow doesn't exist (and there is no `initialDoc`), e.g.
   * back to your list. By default "Create this workflow", which opens a new draft with this ID;
   * `null` offers none.
   */
  notFoundAction?: NotFoundAction | null;
  /** Called after a successful publish with the published version. */
  onPublish?(version: number): void;
  /** Called after every successful save with the new version. */
  onSaved?(version: number): void;
  /** Called with the new run's ID after "Run" starts one. */
  onRunStarted?(runId: string): void;
  /** Rendered at the start of the header, e.g. a back link. */
  headerLeft?: ReactNode;
  /**
   * Renders the side panel of the selected step (shown only while something is selected). By
   * default a placeholder with the step's name and issues.
   */
  renderPanel?: (store: EditorStore) => ReactNode;
  className?: string;
}): JSX.Element {
  const { workflowId, initialDoc, className, headerLeft, renderPanel } = props;
  const { theme, labels } = useFlowkitAppearance();
  const { state, retry, startNew } = useEditorLoad(workflowId, initialDoc, props.create);
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
        <EditorBody store={state.store} {...(renderPanel ? { renderPanel } : {})} />
      </EditorContext.Provider>
    );
  } else if (state.status === "notFound") {
    content = (
      <NotFoundState
        title={labels.workflowNotFound}
        detail={labels.workflowNotFoundDetail(workflowId)}
        action={
          props.notFoundAction === undefined
            ? { label: labels.createWorkflow, onClick: startNew }
            : props.notFoundAction
        }
      />
    );
  } else if (state.status === "error") {
    content = (
      <div className="fk-state" role="alert">
        <p className="fk-state__title">{labels.loadWorkflowFailed}</p>
        <p className="fk-state__detail">{state.message}</p>
        <button type="button" className="fk-btn" onClick={retry}>
          {labels.tryAgain}
        </button>
      </div>
    );
  } else {
    content = (
      <div className="fk-state" role="status" aria-busy="true">
        <span className="fk-skeleton" aria-hidden />
        <p className="fk-state__detail">{labels.loadingWorkflow}</p>
      </div>
    );
  }

  return (
    <div
      className={className ? `fk-root fk-app fk-editor ${className}` : "fk-root fk-app fk-editor"}
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
