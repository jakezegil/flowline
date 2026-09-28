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

export { useShallow };

import { publishRunChange, type RunChange, subscribeRunChanges } from "./run/run-changes";
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
 * (`Object.is`).
 *
 * **Warning:** the selector must return a stable value. Returning a new object or array on every
 * call (`s => ({ a: s.a, b: s.b })`, `s => s.issues.filter(...)`) re-renders on every store
 * change and can loop forever. Select primitives or existing references, wrap object selectors in
 * {@link useShallow}, or derive with `useMemo`:
 *
 * @example
 * const doc = useEditorStore((s) => s.doc);
 * const { dirty, canUndo } = useEditorStore(useShallow((s) => ({ dirty: s.dirty, canUndo: s.canUndo })));
 * const errors = useMemo(() => issues.filter((i) => i.severity === "error"), [issues]);
 */
export function useEditorStore<T>(selector: (s: EditorState & EditorActions) => T): T {
  return useStore(useEditorStoreApi(), selector);
}

/** The document being edited, its validation issues and whether it has unsaved changes. */
export function useWorkflow(): { doc: WorkflowDoc; issues: Issue[]; dirty: boolean } {
  return useEditorStore(useShallow((s) => ({ doc: s.doc, issues: s.issues, dirty: s.dirty })));
}

const stepIndexes = new WeakMap<WorkflowDoc, Map<string, Step>>();

/**
 * Steps of `doc` by ID (first pre-order match), built once per doc snapshot.
 * @internal
 */
export function stepIndex(doc: WorkflowDoc): Map<string, Step> {
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

const NO_ISSUES: Issue[] = [];
const issueIndexes = new WeakMap<Issue[], Map<string, Issue[]>>();
const lastIssueIndexes = new WeakMap<EditorStore, Map<string, Issue[]>>();

/**
 * Whether two issue lists have the same issues in the same order.
 * @internal
 */
export function sameIssues(a: Issue[], b: Issue[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i] as Issue;
      return (
        x.code === y.code &&
        x.field === y.field &&
        x.message === y.message &&
        x.severity === y.severity
      );
    })
  );
}

/**
 * Issues of `issues` grouped by step ID, built once per issues array. A step's group reuses the
 * array from the store's previous grouping when its contents are equal, so edits to one step
 * don't change the issue arrays (and re-render the cards) of the others.
 */
function issuesByStep(store: EditorStore, issues: Issue[]): Map<string, Issue[]> {
  let idx = issueIndexes.get(issues);
  if (!idx) {
    const prev = lastIssueIndexes.get(store);
    const grouped = new Map<string, Issue[]>();
    for (const issue of issues) {
      if (issue.stepId === undefined) continue;
      const list = grouped.get(issue.stepId);
      if (list) list.push(issue);
      else grouped.set(issue.stepId, [issue]);
    }
    for (const [id, list] of grouped) {
      const old = prev?.get(id);
      if (old && sameIssues(old, list)) grouped.set(id, old);
    }
    issueIndexes.set(issues, grouped);
    idx = grouped;
  }
  lastIssueIndexes.set(store, idx);
  return idx;
}

/**
 * A step with its node manifest (`undefined` for unknown node types), its validation issues and
 * test state, or `undefined` if no step has this ID. The result is referentially stable until
 * one of those changes, so edits to other steps don't re-render this step's consumers.
 */
export function useStep(
  id: string,
):
  | { step: Step; manifest: NodeManifest | undefined; issues: Issue[]; testState?: TestState }
  | undefined {
  const store = useEditorStoreApi();
  const step = useStore(store, (s) => stepIndex(s.doc).get(id));
  const nodes = useStore(store, (s) => s.manifest.nodes);
  const issues = useStore(store, (s) => issuesByStep(store, s.issues).get(id) ?? NO_ISSUES);
  const testState = useStore(store, (s) => s.testState[id]);
  return useMemo(() => {
    if (!step) return undefined;
    return {
      step,
      manifest: nodes.find((n) => n.type === step.type),
      issues,
      ...(testState ? { testState } : {}),
    };
  }, [step, nodes, issues, testState]);
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

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);
/** Events after which the client's run stream may end by itself. */
const TERMINAL_RUN_EVENTS: ReadonlySet<string> = new Set([
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.stopped",
]);

/**
 * Loads a run with `client.getRun` and keeps it fresh: refetches (debounced 150ms) whenever
 * `client.subscribeRun` delivers an event, until the stream ends or a fetch shows the run
 * finished (completed, failed or cancelled). A later fetch (e.g. `refresh()` after a retry,
 * which reuses the run id) that shows the run running again subscribes again. `loading` is true until the
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
    let unsubscribe: (() => void) | undefined;
    /** The stream's last event was terminal, so the client may have ended it by itself. */
    let mayHaveEnded = false;
    const listen = () => {
      // A quick retry can show the run running again before any fetch showed it finished.
      if (mayHaveEnded) stopListening();
      unsubscribe ??= client.subscribeRun(runId, (e) => {
        mayHaveEnded = TERMINAL_RUN_EVENTS.has(e.type);
        clearTimeout(timer);
        timer = setTimeout(load, RUN_REFETCH_DEBOUNCE_MS);
      });
    };
    const stopListening = () => {
      unsubscribe?.();
      unsubscribe = undefined;
      mayHaveEnded = false;
    };
    const load = () => {
      const request = ++latest;
      client.getRun(runId).then(
        (detail) => {
          if (!active || request !== latest) return;
          setState({ runId, detail });
          publishRunChange(client, detail.run);
          // A finished run doesn't change until it is retried (same run id): stop listening,
          // and listen again once a refresh shows it running.
          if (TERMINAL_RUN_STATUSES.has(detail.run.status)) stopListening();
          else listen();
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
    listen();
    return () => {
      active = false;
      clearTimeout(timer);
      stopListening();
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

export type { RunChange };

/**
 * Calls `listener` whenever a run's status changes as this app sees it: a `<RunViewer>` or
 * {@link useRun} loading a run (after its live events, a cancel, a retry or a resume), or a
 * `<RunList>` poll finding a listed run in a new state. `<RunList>` uses it to update at once; use
 * it to refresh data of your own that depends on runs, e.g. a count of pending approvals. Needs a
 * `<FlowkitProvider>`.
 *
 * `previous` is the status this app last saw the run in, or `undefined` the first time it sees
 * the run (a viewer opening it): compare the two to react only to real transitions.
 *
 * @example
 * useRunChanges((run, previous) => {
 *   if (previous !== undefined && (previous === "waiting") !== (run.status === "waiting")) {
 *     approvals.reload();
 *   }
 * });
 */
export function useRunChanges(
  listener: (run: RunChange, previous: RunChange["status"] | undefined) => void,
): void {
  const client = useContext(FlowkitClientContext);
  if (!client) throw new Error("useRunChanges must be used inside <FlowkitProvider>");
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(
    () => subscribeRunChanges(client, (run, previous) => ref.current(run, previous)),
    [client],
  );
}
