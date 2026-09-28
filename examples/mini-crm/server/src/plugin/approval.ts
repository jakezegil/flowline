/**
 * The `crm.requestApproval` node, and rebuilding approval records from waiting runs.
 *
 * @module
 */
import { createHash } from "node:crypto";
import {
  branch,
  defineNode,
  FatalError,
  type Step,
  suspend,
  ui,
  walkSteps,
} from "@flowlinejs/core";
import type { Engine } from "@flowlinejs/engine";
import { parseDuration } from "@flowlinejs/nodes-builtin";
import { z } from "zod";
import type { CrmStore } from "../crm-store";
import { userId } from "./contacts";

/** Node type of {@link requestApproval}. */
export const REQUEST_APPROVAL = "crm.requestApproval";

/** The approval ID of the approval step at `stepPath` of run `runId`: stable across retries. */
export function approvalIdFor(runId: string, stepPath: string): string {
  return `apr_${createHash("sha256").update(`${runId}:${stepPath}`).digest("hex").slice(0, 16)}`;
}

/**
 * Asks a CRM user to approve and pauses the run until they decide in the CRM, taking the
 * `approved` or `rejected` branch. An approval that times out counts as rejected.
 *
 * The approval record only points at the waiting step (`runId`, `stepPath`). The CRM's decision
 * endpoint resumes it with the authorized `engine.resumeRun(tenantId, runId, { decision }, userId)`,
 * so no callback token or resume URL is stored anywhere. The step still waits on a callback,
 * because that is what gives the wait its timeout (and what `resumeRun` resumes). The record is
 * created in `suspend`'s `afterCommit`, which runs only once the suspension is committed: an
 * approval is never visible before deciding it can resume the run.
 */
export const requestApproval = defineNode({
  type: REQUEST_APPROVAL,
  name: "Request approval",
  description:
    "Ask a user to approve, and wait for their decision. Takes Rejected if nobody decides in time.",
  icon: "badge-check",
  category: "Approvals",
  keywords: ["approve", "review", "sign off"],
  summary: "Ask for approval: {{title}}",
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
  // Decided in the CRM's Approvals page (which checks who may decide), not by posting a body
  // from the run viewer.
  resume: {
    body: z.object({ decision: z.enum(["approved", "rejected"]) }),
    hostHandled: true,
    hint: "Decide it in the approval bar above, or on the Approvals page.",
  },
  branches: {
    kind: "static",
    branches: [
      { id: "approved", label: "Approved" },
      { id: "rejected", label: "Rejected" },
    ],
  },
  run: async ({ input, ctx }) => {
    const { crm } = ctx.services;
    const approvalId = approvalIdFor(ctx.runId, ctx.stepPath);

    if (ctx.resume?.kind === "timeout") {
      crm.settleApproval(approvalId, "expired");
      return branch("rejected", { approvalId, decision: "rejected" as const, timedOut: true });
    }
    if (ctx.resume?.kind === "callback") {
      const body = ctx.resume.body as { decision?: unknown } | null;
      const decision: "approved" | "rejected" =
        body?.decision === "approved" ? "approved" : "rejected";
      // First outcome wins: the decision endpoint has usually recorded it already.
      crm.settleApproval(approvalId, decision);
      return branch(decision, { approvalId, decision, timedOut: false });
    }

    if (!crm.getUser(input.approverId)) {
      throw new FatalError(`Approver "${input.approverId}" not found`);
    }
    // The handle's token is not kept: the decision resumes the run by ID (see above).
    const callback = await ctx.callback({ timeoutMs: parseDuration(input.timeout) ?? 0 });
    return suspend({
      callback,
      afterCommit: async () => {
        crm.upsertApproval({
          id: approvalId,
          runId: ctx.runId,
          stepPath: ctx.stepPath,
          title: input.title,
          approverId: input.approverId,
        });
      },
    });
  },
});

/**
 * Recreate the pending approval of every run of `tenantId` waiting in a `crm.requestApproval`
 * step, from the step's journaled input. The CRM is in memory while the engine may persist to
 * Postgres: after a restart this makes waiting approvals decidable again. Resolves how many
 * approvals it recorded.
 */
export async function restoreApprovals(
  engine: Engine,
  crm: CrmStore,
  tenantId: string,
): Promise<number> {
  let restored = 0;
  for (const summary of await engine.storage.listRuns(tenantId, {
    status: "waiting",
    limit: 1000,
  })) {
    const detail = await engine.getRunDetail(tenantId, summary.id);
    if (!detail) continue;
    const approvalSteps = new Map<string, Step>();
    walkSteps(detail.doc, (step) => {
      if (step.type === REQUEST_APPROVAL) approvalSteps.set(step.id, step);
    });
    for (const [stepPath, entry] of Object.entries(detail.run.journal)) {
      if (entry.status !== "suspended" || !entry.pending?.hasCallback) continue;
      if (!approvalSteps.has(stepPath.slice(stepPath.lastIndexOf("/") + 1))) continue;
      const input = (entry.input ?? {}) as { title?: unknown; approverId?: unknown };
      const id = approvalIdFor(summary.id, stepPath);
      if (crm.getApproval(id)) continue;
      crm.upsertApproval({
        id,
        runId: summary.id,
        stepPath,
        title: typeof input.title === "string" ? input.title : "Approval",
        approverId: typeof input.approverId === "string" ? input.approverId : "",
        createdAt: new Date(entry.startedAt).toISOString(),
      });
      restored++;
    }
  }
  return restored;
}
