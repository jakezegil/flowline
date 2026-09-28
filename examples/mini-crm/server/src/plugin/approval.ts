/**
 * The `crm.requestApproval` node.
 *
 * @module
 */
import { branch, defineNode, FatalError, suspend, ui } from "@flowkit/core";
import { parseDuration } from "@flowkit/nodes-builtin";
import { z } from "zod";
import { userId } from "./contacts";

/**
 * Asks a CRM user to approve and pauses the run until they decide in the CRM, taking the
 * `approved` or `rejected` branch. An approval that times out counts as rejected.
 *
 * How the resume URL stays secret: `ctx.callback()` issues a one-time token, but node outputs
 * are journaled, so the token is not put in the output. The approval record (holding the token
 * server-side) is created in `suspend`'s `afterCommit`, which runs only once the suspension is
 * committed: an approval is never visible before deciding it can resume the run. The CRM's
 * decision endpoint then resumes the run with `engine.resume(token, { decision })`.
 */
export const requestApproval = defineNode({
  type: "crm.requestApproval",
  name: "Request approval",
  description:
    "Ask a user to approve, and wait for their decision. Takes Rejected if nobody decides in time.",
  icon: "badge-check",
  category: "Approvals",
  summary: "Ask {{approverId}}: {{title}}",
  input: z.object({
    title: ui(z.string().min(1, "Enter what needs approving"), {
      label: "Title",
      placeholder: "Approve enterprise lead",
    }),
    approverId: userId("Approver"),
    timeout: ui(
      z.string().refine((t) => parseDuration(t) !== undefined, "Use e.g. 2h or 3d"),
      {
        label: "Time out after",
        placeholder: "3d",
      },
    )
      .describe("Take the Rejected path if nobody decides in time.")
      .default("3d"),
  }),
  output: z.object({
    approvalId: z.string(),
    decision: z.enum(["approved", "rejected"]),
    timedOut: z.boolean(),
  }),
  branches: {
    kind: "static",
    branches: [
      { id: "approved", label: "Approved" },
      { id: "rejected", label: "Rejected" },
    ],
  },
  run: async ({ input, ctx }) => {
    const { crm } = ctx.services;
    // Stable across retries and the resumed re-invocation of this step.
    const approvalId = `apr_${ctx.idempotencyKey.slice(0, 16)}`;

    if (ctx.resume?.kind === "timeout") {
      crm.settleApproval(approvalId, "expired");
      return branch("rejected", { approvalId, decision: "rejected" as const, timedOut: true });
    }
    if (ctx.resume?.kind === "callback") {
      const body = ctx.resume.body as { decision?: unknown } | null;
      const decision: "approved" | "rejected" =
        body?.decision === "approved" ? "approved" : "rejected";
      crm.settleApproval(approvalId, decision);
      return branch(decision, { approvalId, decision, timedOut: false });
    }

    if (!crm.getUser(input.approverId)) {
      throw new FatalError(`Approver "${input.approverId}" not found`);
    }
    const timeoutMs = parseDuration(input.timeout) ?? 0;
    const callback = await ctx.callback({ timeoutMs });
    return suspend({
      callback,
      afterCommit: async () => {
        crm.upsertApproval({
          id: approvalId,
          runId: ctx.runId,
          title: input.title,
          approverId: input.approverId,
          token: callback.token,
        });
      },
    });
  },
});
