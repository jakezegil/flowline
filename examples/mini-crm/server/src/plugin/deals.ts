/**
 * Deal nodes of the `crm` plugin.
 *
 * @module
 */
import { defineNode, FatalError, ui } from "@flowkit/core";
import { z } from "zod";
import { CrmError, DEAL_STAGES, DealSchema } from "../crm-store";
import { userId } from "./contacts";

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
    dealId: ui(z.string().min(1, "Choose a deal"), { label: "Deal ID", placeholder: "d_1" }),
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
    try {
      return await ctx.services.crm.updateDeal(dealId, changes);
    } catch (err) {
      if (err instanceof CrmError) throw new FatalError(err.message);
      throw err;
    }
  },
});
