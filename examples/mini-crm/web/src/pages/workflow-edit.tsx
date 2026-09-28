/**
 * The workflow editor, full-bleed inside the CRM, with a breadcrumb back to the list. "New
 * workflow" saves the workflow before it opens here, so the editor always loads a saved one.
 *
 * @module
 */
import { WorkflowEditor } from "@flowkit/react";
import type { JSX } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { invalidate } from "../api";

/** The workflow editor page. */
export function WorkflowEditPage(): JSX.Element {
  const { id = "" } = useParams();
  const navigate = useNavigate();

  return (
    <div className="editor-page">
      <WorkflowEditor
        key={id}
        workflowId={id}
        headerLeft={
          <nav aria-label="Breadcrumb" className="crumbs">
            {/* The editor draws its own divider after headerLeft. */}
            <Link to="/workflows">Workflows</Link>
          </nav>
        }
        onSaved={() => invalidate("workflows")}
        onPublish={() => invalidate("workflows")}
        onRunStarted={(runId) => navigate(`/runs/${runId}`)}
      />
    </div>
  );
}
