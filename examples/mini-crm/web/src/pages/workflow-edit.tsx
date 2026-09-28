/**
 * The workflow editor, full-bleed inside the CRM, with a breadcrumb back to the list. A new
 * workflow arrives with its starting doc in the navigation state (from "New workflow").
 *
 * @module
 */
import type { WorkflowDoc } from "@flowkit/core";
import { WorkflowEditor } from "@flowkit/react";
import { ChevronRight } from "lucide-react";
import type { JSX } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { invalidate } from "../api";

/** The workflow editor page. */
export function WorkflowEditPage(): JSX.Element {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const initialDoc = (location.state as { initialDoc?: WorkflowDoc } | null)?.initialDoc;

  return (
    <div className="editor-page">
      <WorkflowEditor
        key={id}
        workflowId={id}
        {...(initialDoc?.id === id ? { initialDoc } : {})}
        headerLeft={
          <nav aria-label="Breadcrumb" className="crumbs">
            <Link to="/workflows">Workflows</Link>
            <ChevronRight size={14} aria-hidden />
          </nav>
        }
        onSaved={() => invalidate("runs")}
        onPublish={() => invalidate("runs")}
        onRunStarted={(runId) => navigate(`/runs/${runId}`)}
      />
    </div>
  );
}
