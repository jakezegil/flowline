import {
  availableScope,
  type Issue,
  type NodeManifest,
  type RunDetail,
  type ScopeEntry,
  type Step,
  type WorkflowDoc,
  walkSteps,
} from "@flowkit/core";
import type { FlowkitClient } from "@flowkit/core/client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { EditorActions, EditorState, EditorStore, TestState } from "./store/editor-store";

/**
 * Provides the {@link EditorStore} that the editor hooks read. `<WorkflowEditor>` and
 * `<WorkflowCanvas>` provide it; wrap custom editor UI in `<EditorContext.Provider value={store}>`.
 */
export const EditorContext = createContext<EditorStore | null>(null);

/**
 * Provides the {@link FlowkitClient} used by data hooks such as {@link useRun}.
 * `<FlowkitProvider>` provides it.
 */
export const FlowkitClientContext = createContext<FlowkitClient | null>(null);

/** The {@link EditorStore} from context, for imperative access (`getState()`, `subscribe`). */
export function useEditorStoreApi(): EditorStore {
  const store = useContext(EditorContext);
  if (!store) {
    throw new Error(
      "Flowkit editor hooks must be used inside <WorkflowEditor>, <WorkflowCanvas> or <EditorContext.Provider value={store}>",
    );
  }
  return store;
}

/**
 * Subscribes to a slice of the editor state; re-renders only when the selected value changes
 * (`Object.is`). Select primitives or stable references, or derive with `useMemo`.
 */
export function useEditorStore<T>(selector: (s: EditorState & EditorActions) => T): T {
  return useStore(useEditorStoreApi(), selector);
}

/** The document being edited, its validation issues and whether it has unsaved changes. */
export function useWorkflow(): { doc: WorkflowDoc; issues: Issue[]; dirty: boolean } {
  return useEditorStore(useShallow((s) => ({ doc: s.doc, issues: s.issues, dirty: s.dirty })));
}

const stepIndexes = new WeakMap<WorkflowDoc, Map<string, Step>>();

/** Steps of `doc` by ID, built once per doc snapshot. */
function stepIndex(doc: WorkflowDoc): Map<string, Step> {
  let idx = stepIndexes.get(doc);
  if (!idx) {
    const built = new Map<string, Step>();
    walkSteps(doc, (step) => {
      if (!built.has(step.id)) built.set(step.id, step);
    });
    stepIndexes.set(doc, built);
    idx = built;
  }
  return idx;
}

/**
 * A step with its node manifest (`undefined` for unknown node types), its validation issues and
 * test state, or `undefined` if no step has this ID. The result is referentially stable until
 * one of those changes.
 */
export function useStep(
  id: string,
):
  | { step: Step; manifest: NodeManifest | undefined; issues: Issue[]; testState?: TestState }
  | undefined {
  const step = useEditorStore((s) => stepIndex(s.doc).get(id));
  const nodes = useEditorStore((s) => s.manifest.nodes);
  const allIssues = useEditorStore((s) => s.issues);
  const testState = useEditorStore((s) => s.testState[id]);
  return useMemo(() => {
    if (!step) return undefined;
    return {
      step,
      manifest: nodes.find((n) => n.type === step.type),
      issues: allIssues.filter((i) => i.stepId === id),
      ...(testState ? { testState } : {}),
    };
  }, [id, step, nodes, allIssues, testState]);
}

/** The current selection (a step ID, `"__trigger"`, or `null`) and a setter. */
export function useSelection(): [string | null, (id: string | null) => void] {
  const selection = useEditorStore((s) => s.selection);
  const select = useEditorStore((s) => s.select);
  return [selection, select];
}

/**
 * The values step `stepId` may reference (trigger, upstream steps, enclosing loop), for the data
 * picker. `null` gives the end-of-workflow scope.
 */
export function useDataPicker(stepId: string | null): ScopeEntry[] {
  const doc = useEditorStore((s) => s.doc);
  const manifest = useEditorStore((s) => s.manifest);
  const ctx = useEditorStore((s) => s.ctx);
  return useMemo(() => availableScope(doc, stepId, manifest, ctx), [doc, stepId, manifest, ctx]);
}

/** All validation issues, error/warning counts, and issues grouped by step ID. */
export function useIssues(): {
  issues: Issue[];
  errors: number;
  warnings: number;
  byStep: Record<string, Issue[]>;
} {
  const issues = useEditorStore((s) => s.issues);
  return useMemo(() => {
    const byStep: Record<string, Issue[]> = {};
    let errors = 0;
    for (const issue of issues) {
      if (issue.severity === "error") errors++;
      if (issue.stepId === undefined) continue;
      const list = byStep[issue.stepId];
      if (list) list.push(issue);
      else byStep[issue.stepId] = [issue];
    }
    return { issues, errors, warnings: issues.length - errors, byStep };
  }, [issues]);
}

/** Debounce (ms) between a live run event and the refetch it triggers. */
const RUN_REFETCH_DEBOUNCE_MS = 150;

/**
 * Loads a run with `client.getRun` and keeps it fresh: refetches (debounced 150ms) whenever
 * `client.subscribeRun` delivers an event, until the stream ends. `loading` is true until the
 * first response for this `runId`; a failed refetch sets `error` and keeps the last `detail`.
 * Requires a {@link FlowkitClientContext} (provided by `<FlowkitProvider>`).
 */
export function useRun(runId: string): {
  detail: RunDetail | undefined;
  loading: boolean;
  error?: Error;
  refresh(): void;
} {
  const client = useContext(FlowkitClientContext);
  if (!client) throw new Error("useRun must be used inside <FlowkitProvider>");
  const [state, setState] = useState<{ runId: string; detail?: RunDetail; error?: Error }>({
    runId,
  });
  const loadRef = useRef<() => void>(() => {});

  useEffect(() => {
    let active = true;
    let latest = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      const request = ++latest;
      client.getRun(runId).then(
        (detail) => {
          if (active && request === latest) setState({ runId, detail });
        },
        (err: unknown) => {
          if (!active || request !== latest) return;
          const error = err instanceof Error ? err : new Error(String(err));
          setState((s) => ({ runId, ...(s.runId === runId ? { detail: s.detail } : {}), error }));
        },
      );
    };
    loadRef.current = load;
    load();
    const unsubscribe = client.subscribeRun(runId, () => {
      clearTimeout(timer);
      timer = setTimeout(load, RUN_REFETCH_DEBOUNCE_MS);
    });
    return () => {
      active = false;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [client, runId]);

  const refresh = useCallback(() => loadRef.current(), []);
  const current = state.runId === runId ? state : { runId };
  return {
    detail: current.detail,
    loading: current.detail === undefined && current.error === undefined,
    ...(current.error ? { error: current.error } : {}),
    refresh,
  };
}
