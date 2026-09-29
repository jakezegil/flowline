/**
 * Loading for `WorkflowEditor`: the manifest, callable sub-flows and the workflow, turned
 * into an editor store once. Also covers a workflow that isn't there (not found) and a new one
 * (create mode, which never asks the server for it).
 *
 * @module
 */

import type { Manifest, ValidationContext, WorkflowDetail, WorkflowDoc } from "@flowlinejs/core";
import { useEffect, useRef, useState } from "react";
import type { FlowlineLabels } from "../labels";
import { useFlowline, useFlowlineAppearance } from "../provider";
import { defaultConfig } from "../store/commands";
import { createEditorStore, type EditorStore } from "../store/editor-store";
import type { NotFoundAction } from "../ui/not-found";
import { errorText, httpStatus, isNetworkError } from "../ui/primitives";

/** A new workflow: a manual trigger (else the first trigger in the manifest) and no steps. */
export function blankDoc(id: string, manifest: Manifest, labels: FlowlineLabels): WorkflowDoc {
  const t = manifest.triggers.find((x) => x.kind === "manual") ?? manifest.triggers[0];
  return {
    id,
    name: labels.untitledWorkflow,
    trigger: { type: t?.type ?? "manual", config: t ? defaultConfig(t.config) : {} },
    steps: [],
  };
}

/** Where the editor's load is. */
export type EditorLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  /** No workflow with this ID, and no `initialDoc` to start one from. */
  | { status: "notFound" }
  | { status: "ready"; store: EditorStore };

/**
 * Loads the manifest, callable sub-flows and the workflow, and creates the editor store once.
 *
 * - `create`: a new workflow; the server isn't asked for it, and the draft starts from
 *   `initialDoc`, else a blank manual workflow. The first save creates it.
 * - `network`: the engine's outbound policy, for URL fields' design-time warnings.
 * - Otherwise the workflow is loaded. If there is none (404) it starts from `initialDoc` when
 *   given, else the state is `notFound`; `startNew()` then switches to create mode.
 * - `onStoreReady` is called for every store created (first load, a `workflowId` change,
 *   `retry()`, `startNew()`); the cleanup it returns runs when that store is replaced (the next
 *   load starts) or the component unmounts.
 */
export function useEditorLoad(
  workflowId: string,
  initialDoc: WorkflowDoc | undefined,
  create = false,
  network?: ValidationContext["network"],
  // biome-ignore lint/suspicious/noConfusingVoidType: `void` so a callback with no cleanup (no return) fits.
  onStoreReady?: (store: EditorStore) => void | (() => void),
): { state: EditorLoadState; retry(): void; startNew(): void } {
  const { client } = useFlowline();
  const { labels } = useFlowlineAppearance();
  const [state, setState] = useState<EditorLoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // Create mode chosen after a not-found, for this workflow ID only.
  const [createdId, setCreatedId] = useState<string | undefined>(undefined);
  const creating = create || createdId === workflowId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: initialDoc, network and labels are read once per load; changing them must not recreate the store.
  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    (async (): Promise<EditorLoadState> => {
      const [manifest, subflows, detail] = await Promise.all([
        client.getManifest(),
        client.listSubflows().catch(() => []),
        creating
          ? Promise.resolve(null)
          : client.getWorkflow(workflowId).catch((err: unknown): WorkflowDetail | null => {
              if (httpStatus(err) === 404) return null;
              throw err;
            }),
      ]);
      if (!detail && !creating && !initialDoc) return { status: "notFound" };
      const ctx: ValidationContext = {
        subflows: Object.fromEntries(
          subflows.map((s) => [s.id, { name: s.name, input: s.input, output: s.output }]),
        ),
        ...(network ? { network } : {}),
      };
      const doc = detail?.latest.doc ?? initialDoc ?? blankDoc(workflowId, manifest, labels);
      const store = createEditorStore({ doc, manifest, ctx });
      if (detail) {
        store.getState().markSaved(detail.latest.version);
        if (detail.published) store.getState().markPublished(detail.published.version);
      }
      return { status: "ready", store };
    })().then(
      (next) => active && setState(next),
      (err: unknown) =>
        active &&
        setState({
          status: "error",
          message: isNetworkError(err) ? labels.serverUnreachable : errorText(err),
        }),
    );
    return () => {
      active = false;
    };
  }, [client, workflowId, attempt, creating]);
  const ready = useRef(onStoreReady);
  ready.current = onStoreReady;
  const store = state.status === "ready" ? state.store : null;
  useEffect(() => {
    if (!store) return;
    const cleanup = ready.current?.(store);
    return typeof cleanup === "function" ? cleanup : undefined;
  }, [store]);
  return {
    state,
    retry: () => setAttempt((n) => n + 1),
    startNew: () => setCreatedId(workflowId),
  };
}

/** `WorkflowEditor`'s `notFoundAction`: the host's action, `"create"`, or `null` for none. */
export type EditorNotFoundAction = NotFoundAction | "create" | null | undefined;

/**
 * The button of the editor's not-found state. By default "Go back" (to the browser's previous
 * page, when there is one): a mistyped link must not be one click away from creating a workflow
 * under the typo. `"create"` opts into "Create this workflow" (`startNew`).
 */
export function notFoundActionFor(
  action: EditorNotFoundAction,
  labels: FlowlineLabels,
  startNew: () => void,
): NotFoundAction | null {
  if (action === "create") return { label: labels.createWorkflow, onClick: startNew };
  if (action !== undefined) return action;
  if (typeof window === "undefined" || window.history.length <= 1) return null;
  return { label: labels.goBack, onClick: () => window.history.back() };
}
