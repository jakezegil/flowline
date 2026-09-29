/**
 * Deal nodes of the `crm` plugin.
 *
 * @module
 */
import { defineNode, FatalError, ui } from "@flowlinejs/core";
import { z } from "zod";
import { DEAL_STAGES, DealSchema } from "../crm-store";
import { crmCall, userId } from "./contacts";

const dealId = () =>
  ui(z.string().min(1, "Choose a deal"), { label: "Deal ID", placeholder: "d_1" });

/** Loads a deal by ID, as it is now. Fails the step when the deal does not exist. */
export const getDeal = defineNode({
  type: "crm.getDeal",
  name: "Get deal",
  description: "Load a deal by deal ID, with its current stage.",
  icon: "handshake",
  category: "Deals",
  summary: "Get deal {{dealId}}",
  input: z.object({ dealId: dealId() }),
  output: z.object({ deal: DealSchema }),
  run: ({ input, ctx }) => {
    const deal = ctx.services.crm.getDeal(input.dealId);
    if (!deal) throw new FatalError(`Deal "${input.dealId}" not found`);
    return { deal };
  },
});

/**
 * Changes a deal's stage, amount or owner. Like any change to a deal, this reports
 * `deal.updated`, so it can start other workflows.
 */
export const updateDeal = defineNode({
  type: "crm.updateDeal",
  name: "Update deal",
  description: "Move a deal to another stage, or change its amount or owner.",
  icon: "handshake",
  category: "Deals",
  summary: "Update deal {{dealId}}",
  input: z.object({
    dealId: dealId(),
    stage: ui(z.enum(DEAL_STAGES), { label: "Stage" }).optional(),
    amount: ui(z.number().nonnegative(), { label: "Amount" }).optional(),
    ownerId: userId("Owner").optional(),
  }),
  output: z.object({
    deal: DealSchema,
    changes: z.array(z.string()).describe("Names of the fields that changed."),
  }),
  run: async ({ input, ctx }) => {
    const { dealId, ...changes } = input;
    return crmCall(() => ctx.services.crm.updateDeal(dealId, changes));
  },
});
