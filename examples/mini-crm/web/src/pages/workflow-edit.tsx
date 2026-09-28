/**
 * The workflow editor, full-bleed inside the CRM, with a breadcrumb back to the list. "New
 * workflow" saves the workflow before it opens here, so the editor always loads a saved one.
 * Leaving for another page with unsaved changes asks first (the editor itself guards reloads and
 * closing the tab).
 *
 * @module
 */
import { WorkflowEditor } from "@flowline/react";
import { type JSX, useState } from "react";
import { Link, useBlocker, useNavigate, useParams } from "react-router";
import { invalidate } from "../api";
import { Dialog } from "../ui";

/** The workflow editor page. */
export function WorkflowEditPage(): JSX.Element {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [dirty, setDirty] = useState(false);
  // Only leaving the page counts: switching workflows remounts the editor, which reports clean.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );

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
        onDirtyChange={setDirty}
        onSaved={() => invalidate("workflows")}
        onPublish={() => invalidate("workflows")}
        onRunStarted={(runId) => navigate(`/runs/${runId}`)}
      />
      <Dialog
        open={blocker.state === "blocked"}
        onClose={() => blocker.reset?.()}
        title="Leave without saving?"
        description="This workflow has changes that aren't saved. If you leave now, they're lost."
      >
        <div className="dialog__foot">
          <button type="button" className="btn" onClick={() => blocker.reset?.()}>
            Keep editing
          </button>
          <button type="button" className="btn btn--danger" onClick={() => blocker.proceed?.()}>
            Leave and discard
          </button>
        </div>
      </Dialog>
    </div>
  );
}
