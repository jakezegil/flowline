/**
 * Approvals: requests from workflows' "Request approval" steps. Approving or rejecting one
 * resumes its waiting run through `POST /api/approvals/:id/decision`.
 *
 * @module
 */
import { BadgeCheck, Check, X } from "lucide-react";
import { type JSX, useState } from "react";
import { Link } from "react-router";
import { type Approval, api, useQuery, useUsers } from "../api";
import { useDecideApproval } from "../decide";
import {
  Badge,
  EmptyState,
  ErrorState,
  fullTime,
  PageHeader,
  SkeletonRows,
  type Tone,
  timeAgo,
  UserChip,
  useNow,
} from "../ui";

const STATUS: Record<Approval["status"], { tone: Tone; label: string }> = {
  pending: { tone: "warning", label: "Pending" },
  approved: { tone: "success", label: "Approved" },
  rejected: { tone: "danger", label: "Rejected" },
  expired: { tone: "neutral", label: "Expired" },
};

type Tab = "pending" | "decided";

/** The approvals page. */
export function ApprovalsPage(): JSX.Element {
  const approvals = useQuery("approvals", api.listApprovals, 4000);
  const { users } = useUsers();
  const now = useNow();
  const [tab, setTab] = useState<Tab>("pending");
  const { busy, decide } = useDecideApproval({ linkRun: true });

  const pending = approvals.data?.filter((a) => a.status === "pending") ?? [];
  const decided = approvals.data?.filter((a) => a.status !== "pending") ?? [];
  const rows = tab === "pending" ? pending : decided;

  return (
    <div className="page">
      <PageHeader
        title="Approvals"
        description="Workflows pause here until someone decides. Your decision resumes the run."
      />
      <div className="tabs" role="tablist" aria-label="Approvals">
        {(["pending", "decided"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className="tabs__tab"
            onClick={() => setTab(t)}
          >
            {t === "pending" ? "Pending" : "Decided"}
            <span className="tabs__count">{t === "pending" ? pending.length : decided.length}</span>
          </button>
        ))}
      </div>

      {approvals.error && !approvals.data ? (
        <ErrorState message={approvals.error} onRetry={approvals.reload} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Request</th>
                <th>Approver</th>
                <th className="num">Requested</th>
                <th>Status</th>
                <th className="num">
                  {tab === "pending" ? <span className="sr-only">Decision</span> : "Decided"}
                </th>
              </tr>
            </thead>
            <tbody>
              {!approvals.data && <SkeletonRows cols={5} rows={3} />}
              {rows.map((a) => (
                <tr key={a.id}>
                  <td>
                    <span className="person__text">
                      <span className="person__name">{a.title}</span>
                      <Link to={`/runs/${a.runId}`} className="person__sub link-quiet">
                        View run
                      </Link>
                    </span>
                  </td>
                  <td>
                    <UserChip
                      user={users?.find((u) => u.id === a.approverId)}
                      fallback={a.approverId}
                    />
                  </td>
                  <td className="num muted" title={fullTime(a.createdAt)}>
                    {timeAgo(a.createdAt, now)}
                  </td>
                  <td>
                    <Badge tone={STATUS[a.status].tone} dot>
                      {STATUS[a.status].label}
                    </Badge>
                  </td>
                  <td className="num">
                    {a.status === "pending" ? (
                      <span className="row-actions">
                        <button
                          type="button"
                          className="btn btn--sm"
                          disabled={busy === a.id}
                          onClick={() => decide(a, "rejected")}
                        >
                          <X size={14} aria-hidden />
                          Reject
                        </button>
                        <button
                          type="button"
                          className="btn btn--sm btn--primary"
                          disabled={busy === a.id}
                          onClick={() => decide(a, "approved")}
                        >
                          <Check size={14} aria-hidden />
                          Approve
                        </button>
                      </span>
                    ) : (
                      <span
                        className="muted"
                        title={a.decidedAt ? fullTime(a.decidedAt) : undefined}
                      >
                        {a.decidedAt ? timeAgo(a.decidedAt, now) : "Never"}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {approvals.data && rows.length === 0 && (
            <EmptyState
              icon={<BadgeCheck size={20} />}
              title={tab === "pending" ? "Nothing waiting for you" : "No decisions yet"}
              action={
                tab === "pending" ? (
                  <Link to="/webhook-tester" className="btn">
                    Send a big lead
                  </Link>
                ) : undefined
              }
            >
              {tab === "pending"
                ? "Leads from companies with 500 or more employees ask a manager before they're routed."
                : "Approved, rejected and expired requests show up here."}
            </EmptyState>
          )}
        </div>
      )}
    </div>
  );
}
