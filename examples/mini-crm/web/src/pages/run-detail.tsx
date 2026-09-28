/**
 * The right half of the runs page: `<RunViewer>` for the run in the URL (`/runs/:id`), or a
 * prompt to pick one. A run waiting on a CRM approval gets a bar to decide it in place.
 *
 * @module
 */
import { RunViewer } from "@flowkit/react";
import { Activity, BadgeCheck, Check, X } from "lucide-react";
import { type JSX, useState } from "react";
import { useNavigate } from "react-router";
import { ApiError, type Approval, api, invalidate, useQuery, useUsers } from "../api";
import { EmptyState, useToast } from "../ui";

/** Approve or reject `approval` without leaving the run. */
function ApprovalBar(props: { approval: Approval }): JSX.Element {
  const { approval } = props;
  const { users } = useUsers();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const approver = users?.find((u) => u.id === approval.approverId)?.name ?? approval.approverId;

  async function decide(decision: "approved" | "rejected") {
    setBusy(true);
    try {
      await api.decide(approval.id, decision);
      toast({ tone: "success", title: decision === "approved" ? "Approved" : "Rejected" });
    } catch (err) {
      toast({
        tone: "danger",
        title: "Couldn't record the decision",
        detail: err instanceof ApiError ? err.message : String(err),
      });
    } finally {
      setBusy(false);
      invalidate("approvals");
    }
  }

  return (
    <section className="approval-bar" aria-label="Approval">
      <BadgeCheck size={16} aria-hidden className="approval-bar__icon" />
      <p className="approval-bar__text">
        <strong>{approval.title}</strong>
        <span className="muted"> is waiting for {approver}.</span>
      </p>
      <button
        type="button"
        className="btn btn--sm"
        disabled={busy}
        onClick={() => decide("rejected")}
      >
        <X size={14} aria-hidden />
        Reject
      </button>
      <button
        type="button"
        className="btn btn--sm btn--primary"
        disabled={busy}
        onClick={() => decide("approved")}
      >
        <Check size={14} aria-hidden />
        Approve
      </button>
    </section>
  );
}

/** The selected run, or an empty state. `query` is kept when a retry opens the new run. */
export function RunDetail(props: { runId: string | undefined; query: string }): JSX.Element {
  const navigate = useNavigate();
  const approvals = useQuery("approvals", api.listApprovals, 4000);
  if (!props.runId) {
    return (
      <EmptyState icon={<Activity size={20} />} title="Pick a run">
        Each run records every step's input, output and timing. Choose one on the left to inspect
        it.
      </EmptyState>
    );
  }
  const pending = approvals.data?.find((a) => a.runId === props.runId && a.status === "pending");
  return (
    <div className="run-detail">
      {pending && <ApprovalBar key={pending.id} approval={pending} />}
      <RunViewer
        key={props.runId}
        runId={props.runId}
        className="run-detail__viewer"
        onRetried={(next) => navigate(`/runs/${next}${props.query}`)}
      />
    </div>
  );
}
