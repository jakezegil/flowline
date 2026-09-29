/**
 * The `deal-stuck-in-stage` workflow: a deal has sat in proposal for three days, so nudge its
 * owner, wait, and escalate to the manager if it is still there.
 *
 * Every side effect is preceded by a fresh load of the deal and a strict stage check, so a run
 * that wakes after the deal moved on stops instead of nudging. The host also cancels a waiting
 * run when its deal's stage changes (see `createMiniCrm`); the workflow stays correct without it.
 *
 * @module
 */
import { ref, tpl, type WorkflowDoc, workflow } from "@flowlinejs/core";
import { and, conditionNode, delayNode, eq, stopNode, strictly } from "@flowlinejs/nodes-builtin";
import { dealStuckInStage, getDeal, getUser, sendEmail } from "../plugin";
import { withStepNames } from "./names";

/** The workflow's ID; the host cancels its waiting runs when a deal's stage changes. */
export const DEAL_STUCK_WORKFLOW_ID = "deal-stuck-in-stage";
/** The manager who hears about deals that stay stuck. */
export const STUCK_DEAL_MANAGER_ID = "u_ava";

/** Nudges the owner of a deal stuck in proposal, then escalates (see the module docs). */
export const dealStuckFlow: WorkflowDoc = withStepNames(
  workflow(DEAL_STUCK_WORKFLOW_ID, {
    name: "Deal stuck in stage",
    description: "Nudge the owner of a deal that sat in proposal for 3 days, then escalate.",
  })
    .trigger(dealStuckInStage, { stage: "proposal", days: 3 })
    .step("deal", getDeal, { dealId: ref("trigger.deal.id") })
    .step(
      "still_there",
      conditionNode,
      { rules: strictly(and(eq(ref("steps.deal.deal.stage"), ref("trigger.deal.stage")))) },
      {
        if: (b) => b,
        else: (b) => b.step("moved_on", stopNode, { reason: "Deal moved on" }),
      },
    )
    .step("owner", getUser, { userId: ref("steps.deal.deal.ownerId") })
    .step("nudge", sendEmail, {
      to: ref("steps.owner.user.email"),
      subject: tpl(
        "{{trigger.deal.name}} has been in {{trigger.deal.stage}} for {{trigger.days}} days",
      ),
      body: tpl(
        "Hi {{steps.owner.user.name}},\n\n{{trigger.deal.name}} hasn't moved for {{trigger.days}} days. Can you follow up today?",
      ),
    })
    // One minute keeps the demo quick; a real escalation would wait a day.
    .step("wait", delayNode, { duration: "1m" })
    .step("recheck", getDeal, { dealId: ref("trigger.deal.id") })
    .step(
      "still_stuck",
      conditionNode,
      { rules: strictly(and(eq(ref("steps.recheck.deal.stage"), ref("trigger.deal.stage")))) },
      {
        if: (b) => b,
        else: (b) => b.step("moved_on_later", stopNode, { reason: "Deal moved on" }),
      },
    )
    .step("manager", getUser, { userId: STUCK_DEAL_MANAGER_ID })
    .step("escalate", sendEmail, {
      to: ref("steps.manager.user.email"),
      subject: tpl("Escalation: {{trigger.deal.name}} is stuck in {{trigger.deal.stage}}"),
      body: tpl(
        "{{trigger.deal.name}} is still in {{trigger.deal.stage}} after {{steps.owner.user.name}} was nudged.",
      ),
    })
    .build(),
  {
    deal: "Load deal",
    still_there: "Still in the stage?",
    moved_on: "Stop: moved on",
    owner: "Load owner",
    nudge: "Nudge owner",
    wait: "Wait a minute",
    recheck: "Load deal again",
    still_stuck: "Still stuck?",
    moved_on_later: "Stop: moved on",
    manager: "Load manager",
    escalate: "Escalate to manager",
  },
);
