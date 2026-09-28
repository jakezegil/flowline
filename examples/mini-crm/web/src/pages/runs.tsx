/**
 * Runs: `<RunList>` beside the selected run. `/runs` lists every run (or one workflow's, with
 * `?workflow=`); `/runs/:id` deep links a run. Both paths render this page, so picking a run
 * keeps the list mounted.
 *
 * @module
 */
import type { WorkflowSummary } from "@flowlinejs/core/client";
import { RunList } from "@flowlinejs/react";
import type { JSX } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { flowline, useQuery } from "../api";
import { useRunSubjects } from "../run-subject";
import { RunDetail } from "./run-detail";

/** Longest workflow name shown in the filter before it is cut with an ellipsis. */
const MAX_OPTION = 40;

/** `name`, cut at a word boundary to at most {@link MAX_OPTION} characters. */
export function shortName(name: string, max = MAX_OPTION): string {
  if (name.length <= max) return name;
  const cut = name.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The runs page. */
export function RunsPage(): JSX.Element {
  const { id: runId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const workflowId = params.get("workflow") ?? undefined;
  const workflows = useQuery<WorkflowSummary[]>("workflows", () => flowline.listWorkflows());
  const query = workflowId ? `?workflow=${encodeURIComponent(workflowId)}` : "";
  const describeRun = useRunSubjects();
  const selected = workflows.data?.find((w) => w.id === workflowId);

  return (
    <div className="runs-page">
      <aside className="runs-page__list" aria-label="Runs">
        <div className="runs-page__head">
          <h1 className="runs-page__title">Runs</h1>
          <select
            className="input input--sm"
            aria-label="Filter by workflow"
            title={selected?.name}
            value={workflowId ?? ""}
            onChange={(e) => {
              const next = new URLSearchParams(params);
              if (e.target.value) next.set("workflow", e.target.value);
              else next.delete("workflow");
              setParams(next);
            }}
          >
            <option value="">All workflows</option>
            {workflows.data?.map((w) => (
              <option key={w.id} value={w.id} title={w.name}>
                {shortName(w.name)}
              </option>
            ))}
          </select>
        </div>
        <RunList
          key={workflowId ?? "all"}
          {...(workflowId ? { workflowId } : {})}
          {...(runId ? { selectedRunId: runId } : {})}
          pollMs={3000}
          describeRun={describeRun}
          onSelect={(id) => navigate(`/runs/${id}${query}`)}
        />
      </aside>
      <section className="runs-page__viewer" aria-label="Run">
        <RunDetail runId={runId} query={query} />
      </section>
    </div>
  );
}
