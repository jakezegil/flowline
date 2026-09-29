/**
 * The demo workflows and their seeding.
 *
 * @module
 */
import type { WorkflowDoc } from "@flowlinejs/core";
import type { Engine } from "@flowlinejs/engine";
import { anyCallEndedFlow } from "./any-call-ended";
import { dealStuckFlow } from "./deal-stuck";
import { dealWonFollowUpFlow } from "./deal-won";
import { inboundLeadRoutingFlow } from "./lead-routing";
import { createContactFlow, getContactFlow, getOrCreateContactFlow } from "./subflows";

export { anyCallEndedFlow, MIN_CALL_SECONDS } from "./any-call-ended";
export { DEAL_STUCK_WORKFLOW_ID, dealStuckFlow, STUCK_DEAL_MANAGER_ID } from "./deal-stuck";
export { dealWonFollowUpFlow } from "./deal-won";
export { inboundLeadRoutingFlow } from "./lead-routing";
export { createContactFlow, getContactFlow, getOrCreateContactFlow } from "./subflows";

/**
 * Every demo workflow, in publishing order: a workflow calling a sub-flow is validated against
 * the published sub-flows, so sub-flows come first.
 */
export const demoFlows: readonly WorkflowDoc[] = [
  getContactFlow,
  createContactFlow,
  getOrCreateContactFlow,
  inboundLeadRoutingFlow,
  dealWonFollowUpFlow,
  anyCallEndedFlow,
  dealStuckFlow,
];

/**
 * Save and publish the demo workflows the tenant does not have yet. Existing workflows are left
 * alone, so edits made in the editor survive a restart against Postgres.
 *
 * @throws `FlowlineValidationError` if a demo workflow does not validate.
 */
export async function seedFlows(engine: Engine, tenantId: string, actor = "seed"): Promise<void> {
  const existing = new Set((await engine.storage.listWorkflows(tenantId)).map((w) => w.id));
  for (const doc of demoFlows) {
    if (existing.has(doc.id)) continue;
    const saved = await engine.saveWorkflow(tenantId, doc, actor);
    await engine.publish(tenantId, doc.id, saved.version, actor);
  }
}
