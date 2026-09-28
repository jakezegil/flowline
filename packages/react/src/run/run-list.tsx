import type { RunStatus, RunSummary } from "@flowkit/core";
import { type JSX, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFlowkit, useFlowkitAppearance } from "../provider";
import { themeStyle } from "../theme";
import { errorText, useNow } from "../ui/primitives";
import { publishRunChange, type RunChange, subscribeRunChanges } from "./run-changes";
import { displayState, isTerminal, useRunStateName } from "./run-status";
import { useWorkflowNames } from "./use-workflow-names";

/** A filter tab: a run status, or "stopped" (completed by a Stop step). */
type RunFilter = RunStatus | "stopped";

const FILTERS: (RunFilter | undefined)[] = [
  undefined,
  "running",
  "waiting",
  "failed",
  "completed",
  "stopped",
  "cancelled",
];

/** Debounce (ms) between a run change and the reload it triggers. */
const CHANGE_RELOAD_MS = 100;
/** A focus or visibility reload this soon after another load is skipped. */
const REFOCUS_COALESCE_MS = 250;

/** The `listRuns` filter of a tab: "Completed" leaves out stopped runs, which have their own. */
function filterOf(tab: RunFilter | undefined): { status?: RunStatus; stopped?: boolean } {
  if (tab === "stopped") return { status: "completed", stopped: true };
  if (tab === "completed") return { status: "completed", stopped: false };
  return tab ? { status: tab } : {};
}

/** Whether `run` belongs in the list of tab `tab` (of workflow `workflowId`, if set). */
function matchesTab(
  run: RunChange,
  tab: RunFilter | undefined,
  workflowId: string | undefined,
): boolean {
  if (workflowId !== undefined && run.workflowId !== workflowId) return false;
  const { status, stopped } = filterOf(tab);
  if (status !== undefined && run.status !== status) return false;
  if (stopped !== undefined && (run.stoppedAt !== undefined) !== stopped) return false;
  return true;
}

/**
 * Loads `listRuns` for a filter and keeps it fresh: every `pollMs` while the page is visible, as
 * soon as the window regains focus or the page becomes visible, and at once when another view of
 * the same client (a `<RunViewer>`, `useRun`) sees a run change status. A listed run that changed
 * is updated in place before the reload lands.
 */
function useRunList(
  workflowId: string | undefined,
  status: RunFilter | undefined,
  topLevel: boolean,
  pollMs: number,
) {
  const { client } = useFlowkit();
  const [state, setState] = useState<{ key: string; runs?: RunSummary[]; error?: string }>({
    key: "",
  });
  const key = `${workflowId ?? ""}|${status ?? ""}|${topLevel}`;
  const loadRef = useRef<() => void>(() => {});
  const rowsRef = useRef<{ key: string; runs?: RunSummary[] }>({ key: "" });
  useEffect(() => {
    let active = true;
    let latest = 0;
    let changeTimer: ReturnType<typeof setTimeout> | undefined;
    const show = (next: { key: string; runs?: RunSummary[]; error?: string }) => {
      rowsRef.current = next;
      setState(next);
    };
    let startedAt = Number.NEGATIVE_INFINITY;
    const load = () => {
      startedAt = Date.now();
      const request = ++latest;
      client
        .listRuns({
          ...(workflowId !== undefined ? { workflowId } : {}),
          ...filterOf(status),
          ...(topLevel ? { topLevel } : {}),
        })
        .then(
          (runs) => {
            if (!active || request !== latest) return;
            show({ key, runs });
            // Tell the other views about listed runs that moved on since they last looked.
            for (const r of runs) publishRunChange(client, r, { onlyIfKnown: true });
          },
          (err: unknown) => {
            if (!active || request !== latest) return;
            // Keep the rows of a failed poll; only a first load shows the error.
            const s = rowsRef.current;
            if (!(s.key === key && s.runs)) show({ key, error: errorText(err) });
          },
        );
    };
    loadRef.current = load;
    load();
    // Polls skip while the page is hidden; coming back (or focusing the window) reloads at once.
    const hidden = () => typeof document !== "undefined" && document.hidden;
    const timer = pollMs > 0 ? setInterval(() => !hidden() && load(), pollMs) : undefined;
    // Returning to the tab fires `visibilitychange` and `focus` together: load once for both.
    const onVisible = () => !hidden() && Date.now() - startedAt >= REFOCUS_COALESCE_MS && load();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const unsubscribe = subscribeRunChanges(client, (run) => {
      const s = rowsRef.current;
      if (s.key !== key || !s.runs) return;
      const i = s.runs.findIndex((r) => r.id === run.id);
      const listed = i === -1 ? undefined : s.runs[i];
      if (listed) {
        if (listed.status === run.status && listed.stoppedAt === run.stoppedAt) return;
        const { stoppedAt: _old, ...rest } = listed;
        const patched: RunSummary = {
          ...rest,
          status: run.status,
          updatedAt: run.updatedAt,
          ...(run.stoppedAt !== undefined ? { stoppedAt: run.stoppedAt } : {}),
        };
        const runs = [...s.runs];
        if (matchesTab(patched, status, workflowId)) runs[i] = patched;
        else runs.splice(i, 1);
        show({ key, runs });
      } else if (!matchesTab(run, status, workflowId)) {
        return;
      }
      clearTimeout(changeTimer);
      changeTimer = setTimeout(load, CHANGE_RELOAD_MS);
    });
    return () => {
      active = false;
      clearInterval(timer);
      clearTimeout(changeTimer);
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [client, workflowId, status, topLevel, pollMs, key]);
  const retry = useCallback(() => {
    rowsRef.current = { key: "" };
    setState({ key: "" });
    loadRef.current();
  }, []);
  return { ...(state.key === key ? state : {}), retry };
}

/**
 * A compact, live list of runs, newest first: status (a run a Stop step ended reads "Stopped"),
 * when it started, how long it took, what started it, and the workflow version. Filter tabs
 * narrow it by status ("Completed" and "Stopped" are separate). It refreshes every `pollMs`
 * (5 seconds by default), when the window regains focus, and at once when a `<RunViewer>` of the
 * same `<FlowkitProvider>` sees a run change (e.g. after Cancel run). Across all workflows it
 * names each run's workflow and leaves out sub-flow runs (see `includeSubflowRuns`). Pair it with
 * `<RunViewer>`. Needs a `<FlowkitProvider>`.
 *
 * @example
 * <RunList workflowId="welcome" selectedRunId={runId} onSelect={setRunId} />
 */
export function RunList(props: {
  /** Only this workflow's runs; all workflows (each row naming its workflow) when omitted. */
  workflowId?: string;
  /**
   * Also list runs started by a sub-flow step (`startedBy.kind === "subflow"`). By default they
   * are listed only for a single `workflowId` (whose runs may all be sub-flow runs) and left out
   * of the all-workflows list, where they would crowd out the runs people started.
   */
  includeSubflowRuns?: boolean;
  selectedRunId?: string;
  onSelect(runId: string): void;
  /** Refresh interval in ms (default 5000; 0 turns polling off). */
  pollMs?: number;
  /**
   * What the run is about, shown next to its status so similar rows can be told apart, e.g. the
   * lead's email. Return `undefined` for nothing.
   */
  describeRun?(run: RunSummary): ReactNode;
  className?: string;
}): JSX.Element {
  const { workflowId, selectedRunId, onSelect, pollMs = 5000, className, describeRun } = props;
  const includeSubflowRuns = props.includeSubflowRuns ?? workflowId !== undefined;
  const { theme, labels } = useFlowkitAppearance();
  const stateName = useRunStateName();
  const [status, setStatus] = useState<RunFilter | undefined>(undefined);
  const { runs, error, retry } = useRunList(workflowId, status, !includeSubflowRuns, pollMs);
  const names = useWorkflowNames(
    useMemo(() => runs?.map((r) => r.workflowId) ?? [], [runs]),
    workflowId === undefined,
  );
  const live = runs?.some((r) => !isTerminal(r.status)) ?? false;
  const now = useNow(live ? 1000 : 30_000, true);
  const style = useMemo(() => themeStyle(theme.tokens), [theme.tokens]);

  let body: JSX.Element;
  if (error) {
    body = (
      <div className="fk-runs__state" role="alert">
        <p>{labels.loadRunsFailed}</p>
        <p className="fk-runs__detail">{error}</p>
        <button type="button" className="fk-btn fk-btn--sm" onClick={retry}>
          {labels.tryAgain}
        </button>
      </div>
    );
  } else if (!runs) {
    body = (
      <ul className="fk-runs__rows" aria-busy="true" aria-label={labels.runs}>
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="fk-runs__skeleton" aria-hidden />
        ))}
      </ul>
    );
  } else if (runs.length === 0) {
    body = (
      <div className="fk-runs__state">
        <p>{status ? labels.noRunsWithStatus(stateName(status)) : labels.noRuns}</p>
      </div>
    );
  } else {
    body = (
      <ul className="fk-runs__rows" aria-label={labels.runs}>
        {runs.map((r) => {
          const end = isTerminal(r.status) ? r.updatedAt : now;
          const state = displayState(r);
          const subject = describeRun?.(r);
          return (
            <li key={r.id}>
              <button
                type="button"
                className="fk-runs__row"
                data-status={state}
                aria-current={r.id === selectedRunId ? "true" : undefined}
                onClick={() => onSelect(r.id)}
              >
                <span className="fk-runs__dot" aria-hidden />
                <span className="fk-runs__main">
                  <span className="fk-runs__status">{stateName(state)}</span>
                  {subject !== undefined && subject !== null && subject !== "" && (
                    <span className="fk-runs__subject">{subject}</span>
                  )}
                  <span className="fk-runs__time" title={labels.dateTime(r.createdAt)}>
                    {labels.relativeTime(r.createdAt - now)}
                  </span>
                </span>
                <span className="fk-runs__sub">
                  <span className="fk-runs__origin">
                    {workflowId === undefined
                      ? `${names.get(r.workflowId) ?? r.workflowId} · `
                      : ""}
                    {labels.origin(r.startedBy)}
                  </span>
                  <span className="fk-runs__nums">
                    <span className="fk-tabular">
                      {labels.duration(Math.max(0, end - r.createdAt))}
                    </span>
                    <span className="fk-version">{labels.version(r.version)}</span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div
      className={className ? `fk-root fk-runs ${className}` : "fk-root fk-runs"}
      data-fk-theme={theme.colorMode ?? "system"}
      style={style}
    >
      <fieldset className="fk-runs__filters" aria-label={labels.filterRuns}>
        {FILTERS.map((f) => (
          <button
            key={f ?? "all"}
            type="button"
            className="fk-runs__filter"
            aria-pressed={f === status}
            {...(f ? { "data-status": f } : {})}
            onClick={() => setStatus(f)}
          >
            {f ? stateName(f) : labels.allRuns}
          </button>
        ))}
      </fieldset>
      {body}
    </div>
  );
}
