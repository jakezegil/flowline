/**
 * Triggers of the `crm` plugin. The app forwards the CRM store's events to `engine.emit`.
 *
 * @module
 */
import { defineTrigger, ui } from "@flowkit/core";
import { z } from "zod";
import { ContactSchema, DEAL_STAGES, DealSchema } from "../crm-store";

/** Starts a run whenever a contact is created (in the CRM UI, the API or by a workflow). */
export const contactCreated = defineTrigger({
  type: "crm.contactCreated",
  name: "Contact created",
  description: "Start when a new contact is added to the CRM.",
  icon: "user-plus",
  kind: "event",
  event: "contact.created",
  config: z.object({}),
  payload: z.object({ contact: ContactSchema }),
});

/** Starts a run when a deal changes, optionally only when its stage changes (to one stage). */
export const dealUpdated = defineTrigger({
  type: "crm.dealUpdated",
  name: "Deal updated",
  description: "Start when a deal changes, for example when it moves to another stage.",
  icon: "handshake",
  kind: "event",
  event: "deal.updated",
  config: z.object({
    onlyWhenStageChanges: ui(z.boolean(), { label: "Only when the stage changes" }).default(false),
    stage: ui(z.enum(DEAL_STAGES), { label: "Stage" })
      .describe("Only start when the deal is now in this stage.")
      .optional(),
  }),
  payload: z.object({
    deal: DealSchema,
    changes: z.array(z.string()).describe("Names of the fields that changed, e.g. stage."),
  }),
  filter: ({ config, payload }) =>
    (!config.onlyWhenStageChanges || payload.changes.includes("stage")) &&
    (config.stage === undefined || payload.deal.stage === config.stage),
});
