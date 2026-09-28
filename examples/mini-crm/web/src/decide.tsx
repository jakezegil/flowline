/**
 * Deciding an approval, shared by the Approvals page and the bar above a waiting run.
 *
 * @module
 */
import { useCallback, useState } from "react";
import { Link } from "react-router";
import { ApiError, type Approval, api, invalidate } from "./api";
import { useToast } from "./ui";

/** What went wrong deciding an approval, in words. */
function decisionError(err: unknown): string {
  if (err instanceof ApiError && err.status === 410) {
    return "The run stopped waiting (it timed out or was cancelled).";
  }
  if (err instanceof ApiError && err.status === 409) return "Someone already decided it.";
  return err instanceof Error ? err.message : String(err);
}

/**
 * `decide(approval, decision)` posts the decision, toasts the outcome and refreshes the
 * approvals and the outbox. `busy` is the ID of the approval being decided. `linkRun` adds an
 * "Open run" link to the success toast.
 */
export function useDecideApproval(opts: { linkRun?: boolean } = {}): {
  busy: string | null;
  decide(approval: Approval, decision: "approved" | "rejected"): Promise<boolean>;
} {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const linkRun = opts.linkRun ?? false;
  const decide = useCallback(
    async (a: Approval, decision: "approved" | "rejected") => {
      setBusy(a.id);
      try {
        await api.decide(a.id, decision);
        toast({
          tone: "success",
          title: decision === "approved" ? "Approved" : "Rejected",
          detail: linkRun ? (
            <>
              The run continues. <Link to={`/runs/${a.runId}`}>Open run</Link>
            </>
          ) : (
            "The run continues."
          ),
        });
        return true;
      } catch (err) {
        toast({
          tone: "danger",
          title: "Couldn't record the decision",
          detail: decisionError(err),
        });
        return false;
      } finally {
        setBusy(null);
        invalidate("approvals");
        invalidate("outbox");
      }
    },
    [toast, linkRun],
  );
  return { busy, decide };
}
