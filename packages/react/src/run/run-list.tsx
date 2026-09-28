import type { RunStatus, RunSummary } from "@flowkit/core";
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFlowkit, useFlowkitAppearance } from "../provider";
import { themeStyle } from "../theme";
import { errorText, useNow } from "../ui/primitives";
import { isTerminal } from "./run-status";

const FILTERS: (RunStatus | undefined)[] = [
  undefined,
  "running",
  "waiting",
  "failed",
  "completed",
  "cancelled",
];

/** Loads `listRuns` for a filter and reloads it every `pollMs` while mounted. */
function useRunList(workflowId: string | undefined, status: RunStatus | undefined, pollMs: number) {
  const { client } = useFlowkit();
  const [state, setState] = useState<{ key: string; runs?: RunSummary[]; error?: string }>({
    key: "",
  });
  const key = `${workflowId ?? ""}|${status ?? ""}`;
  const loadRef = useRef<() => void>(() => {});
  useEffect(() => {
    let active = true;
    let latest = 0;
    const load = () => {
      const request = ++latest;
      client
        .listRuns({
          ...(workflowId !== undefined ? { workflowId } : {}),
          ...(status !== undefined ? { status } : {}),
        })
        .then(
          (runs) => active && request === latest && setState({ key, runs }),
          (err: unknown) =>
            active &&
            request === latest &&
            // Keep the rows of a failed poll; only a first load shows the error.
            setState((s) => (s.key === key && s.runs ? s : { key, error: errorText(err) })),
        );
    };
    loadRef.current = load;
    load();
    // Polls skip while the page is hidden; coming back reloads at once.
    const hidden = () => typeof document !== "undefined" && document.hidden;
    const timer = pollMs > 0 ? setInterval(() => !hidden() && load(), pollMs) : undefined;
    const onVisible = () => !hidden() && load();
    if (pollMs > 0) document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [client, workflowId, status, pollMs, key]);
  const retry = useCallback(() => {
    setState({ key: "" });
    loadRef.current();
  }, []);
  return { ...(state.key === key ? state : {}), retry };
}

/**
 * A compact, live list of runs, newest first: status, when it started, how long it took, what
 * started it, and the workflow version. Filter tabs narrow it by status; it refreshes every
 * `pollMs` (5 seconds by default). Pair it with `<RunViewer>`. Needs a `<FlowkitProvider>`.
 *
 * @example
 * <RunList workflowId="welcome" selectedRunId={runId} onSelect={setRunId} />
 */
export function RunList(props: {
  /** Only this workflow's runs; all workflows (with their IDs shown) when omitted. */
  workflowId?: string;
  selectedRunId?: string;
  onSelect(runId: string): void;
  /** Refresh interval in ms (default 5000; 0 turns polling off). */
  pollMs?: number;
  className?: string;
}): JSX.Element {
  const { workflowId, selectedRunId, onSelect, pollMs = 5000, className } = props;
  const { theme, labels } = useFlowkitAppearance();
  const [status, setStatus] = useState<RunStatus | undefined>(undefined);
  const { runs, error, retry } = useRunList(workflowId, status, pollMs);
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
        <p>{status ? labels.noRunsWithStatus(labels.runState[status]) : labels.noRuns}</p>
      </div>
    );
  } else {
    body = (
      <ul className="fk-runs__rows" aria-label={labels.runs}>
        {runs.map((r) => {
          const end = isTerminal(r.status) ? r.updatedAt : now;
          return (
            <li key={r.id}>
              <button
                type="button"
                className="fk-runs__row"
                data-status={r.status}
                aria-current={r.id === selectedRunId ? "true" : undefined}
                onClick={() => onSelect(r.id)}
              >
                <span className="fk-runs__dot" aria-hidden />
                <span className="fk-runs__main">
                  <span className="fk-runs__status">{labels.runState[r.status]}</span>
                  <span className="fk-runs__time" title={labels.dateTime(r.createdAt)}>
                    {labels.relativeTime(r.createdAt - now)}
                  </span>
                </span>
                <span className="fk-runs__sub">
                  <span className="fk-runs__origin">
                    {workflowId === undefined ? `${r.workflowId} · ` : ""}
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
            {f ? labels.runState[f] : labels.allRuns}
          </button>
        ))}
      </fieldset>
      {body}
    </div>
  );
}
