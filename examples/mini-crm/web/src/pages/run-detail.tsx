/**
 * The right half of the runs page: `<RunViewer>` for the run in the URL (`/runs/:id`), or a
 * prompt to pick one. A run waiting on a CRM approval gets a bar to decide it in place.
 *
 * @module
 */
import { RunViewer, useRun } from "@flowlinejs/react";
import { Activity, BadgeCheck, Check, X } from "lucide-react";
import { type JSX, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { type Approval, api, useQuery, useUsers } from "../api";
import { useDecideApproval } from "../decide";
import { EmptyState } from "../ui";

/** Approve or reject `approval` without leaving the run. */
function ApprovalBar(props: { approval: Approval; onDecided(): void }): JSX.Element {
  const { approval, onDecided } = props;
  const { users } = useUsers();
  const { busy, decide } = useDecideApproval();
  const approver = users?.find((u) => u.id === approval.approverId)?.name ?? "the approver";

  async function onDecide(decision: "approved" | "rejected") {
    if (await decide(approval, decision)) onDecided();
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
        disabled={busy !== null}
        onClick={() => onDecide("rejected")}
      >
        <X size={14} aria-hidden />
        Reject
      </button>
      <button
        type="button"
        className="btn btn--sm btn--primary"
        disabled={busy !== null}
        onClick={() => onDecide("approved")}
      >
        <Check size={14} aria-hidden />
        Approve
      </button>
    </section>
  );
}

/**
 * The pending CRM approval of run `runId`, while the run waits on it. The run's status comes from
 * the same event stream the viewer uses, so the bar appears as the run suspends and goes as soon
 * as it resumes or is cancelled, however that happened.
 */
function usePendingApproval(runId: string): {
  approval: Approval | undefined;
  markDecided(): void;
} {
  const { detail } = useRun(runId);
  const waiting = detail?.run.status === "waiting";
  const [decided, setDecided] = useState<string | null>(null);
  const [lookFast, setLookFast] = useState(false);
  // The approval is created right after the run suspends: poll quickly until it shows up.
  const approvals = useQuery("approvals", api.listApprovals, lookFast ? 500 : 5000);
  const approval = waiting
    ? approvals.data?.find((a) => a.runId === runId && a.status === "pending" && a.id !== decided)
    : undefined;
  const { reload } = approvals;

  useEffect(() => {
    if (waiting) reload();
  }, [waiting, reload]);

  // Only a step waiting on a callback (in this CRM, Request approval) has an approval coming.
  const expectsApproval =
    waiting &&
    Object.values(detail?.run.journal ?? {}).some(
      (entry) => entry.status === "suspended" && entry.pending?.hasCallback === true,
    );
  const fast = expectsApproval && !approval;
  useEffect(() => setLookFast(fast), [fast]);

  return { approval, markDecided: () => setDecided(approval?.id ?? null) };
}

/**
 * A user's name by ID for the run viewer (who cancelled a run): a CRM user's name, "Demo user" for the
 * demo's signed-in user, or `undefined` (the viewer then shows the ID).
 */
export function useUserName(): (userId: string) => string | undefined {
  const { users } = useUsers();
  // Only the signed-in user's ID is read, and it never changes.
  const demo = useQuery("static", api.demo);
  const me = demo.data?.userId;
  return useCallback(
    (userId: string) =>
      users?.find((u) => u.id === userId)?.name ?? (userId === me ? "Demo user" : undefined),
    [users, me],
  );
}

function Run(props: { runId: string; query: string }): JSX.Element {
  const navigate = useNavigate();
  const { approval, markDecided } = usePendingApproval(props.runId);
  const userName = useUserName();
  return (
    <div className="run-detail">
      {approval && <ApprovalBar key={approval.id} approval={approval} onDecided={markDecided} />}
      <RunViewer
        runId={props.runId}
        className="run-detail__viewer"
        userName={userName}
        onRetried={(next) => navigate(`/runs/${next}${props.query}`)}
      />
    </div>
  );
}

/** The selected run, or an empty state. `query` is kept when a retry opens the new run. */
export function RunDetail(props: { runId: string | undefined; query: string }): JSX.Element {
  if (!props.runId) {
    return (
      <EmptyState icon={<Activity size={20} />} title="Pick a run">
        Each run records every step's input, output and timing. Choose one on the left to inspect
        it.
      </EmptyState>
    );
  }
  return <Run key={props.runId} runId={props.runId} query={props.query} />;
}
