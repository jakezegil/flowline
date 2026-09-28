/**
 * Runs: `<RunList>` beside the selected run. `/runs` lists every run (or one workflow's, with
 * `?workflow=`); `/runs/:id` deep links a run. Both paths render this page, so picking a run
 * keeps the list mounted.
 *
 * @module
 */
import type { WorkflowSummary } from "@flowkit/core/client";
import { RunList } from "@flowkit/react";
import type { JSX } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { flowkit, useQuery } from "../api";
import { RunDetail } from "./run-detail";

/** The runs page. */
export function RunsPage(): JSX.Element {
  const { id: runId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const workflowId = params.get("workflow") ?? undefined;
  const workflows = useQuery<WorkflowSummary[]>("runs", () => flowkit.listWorkflows());
  const query = workflowId ? `?workflow=${encodeURIComponent(workflowId)}` : "";

  return (
    <div className="runs-page">
      <aside className="runs-page__list" aria-label="Runs">
        <div className="runs-page__head">
          <h1 className="runs-page__title">Runs</h1>
          <select
            className="input input--sm"
            aria-label="Filter by workflow"
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
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        <RunList
          key={workflowId ?? "all"}
          {...(workflowId ? { workflowId } : {})}
          {...(runId ? { selectedRunId: runId } : {})}
          pollMs={3000}
          onSelect={(id) => navigate(`/runs/${id}${query}`)}
        />
      </aside>
      <section className="runs-page__viewer" aria-label="Run">
        <RunDetail runId={runId} query={query} />
      </section>
    </div>
  );
}
