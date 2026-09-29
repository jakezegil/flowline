/**
 * Triggers of the `crm` plugin. The app forwards the CRM store's events to `engine.emit`; the
 * poll trigger is swept by the engine's worker (`engine.tickPolls`).
 *
 * @module
 */
import { defineTrigger, ui } from "@flowlinejs/core";
import { z } from "zod";
import { ContactSchema, DEAL_STAGES, DealSchema } from "../crm-store";

const DAY = 86_400_000;

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

const CallEnded = z.object({
  call: z.object({
    id: z.string(),
    contactId: z.string(),
    source: z.enum(["ai", "voip"]).describe("Which system made the call."),
    durationSec: z.number(),
    endedAt: z.iso.datetime(),
    summary: z.string().optional().describe("Transcript summary (AI calls only)."),
  }),
});

/**
 * Starts a run when any call ends, whichever system made it. The AI agent and the phone system
 * report differently shaped events; `normalize` maps both onto one payload, and the call ID
 * dedupes a redelivered event for an hour.
 */
export const callEnded = defineTrigger({
  type: "crm.callEnded",
  name: "Any call ended",
  description: "Start when an AI or VoIP call with a contact ends.",
  icon: "phone-off",
  kind: "event",
  events: ["ai_call.ended", "voip_call.ended"],
  config: z.object({
    minSeconds: ui(z.number().int().min(0), { label: "Minimum length (seconds)" }).default(0),
  }),
  payload: CallEnded,
  normalize: (event, raw) => {
    if (event === "ai_call.ended") {
      const r = raw as {
        call: {
          id: string;
          contactId: string;
          seconds: number;
          endedAt: string;
          transcriptSummary: string;
        };
      };
      return {
        call: {
          id: r.call.id,
          contactId: r.call.contactId,
          source: "ai" as const,
          durationSec: r.call.seconds,
          endedAt: r.call.endedAt,
          summary: r.call.transcriptSummary,
        },
      };
    }
    const r = raw as { callId: string; contactId: string; durationMs: number; endedAt: string };
    return {
      call: {
        id: r.callId,
        contactId: r.contactId,
        source: "voip" as const,
        durationSec: Math.round(r.durationMs / 1000),
        endedAt: r.endedAt,
      },
    };
  },
  filter: ({ config, payload }) => payload.call.durationSec >= config.minSeconds,
  dedupe: { key: ({ payload }) => payload.call.id, window: "1h" },
});

/**
 * Starts once for each deal that has been in a stage for a number of days. Each sweep looks for
 * deals still in the stage whose threshold fell in the swept interval, so a deal fires once when
 * it crosses, never for a deal that moved on first, and again only after re-entering the stage
 * (a new `stageEnteredAt`, so a new item key).
 */
export const dealStuckInStage = defineTrigger({
  type: "crm.dealStuckInStage",
  name: "Deal stuck in stage",
  description: "Start once for each deal that has been in a stage for a number of days.",
  icon: "hourglass",
  kind: "poll",
  // Short so the demo and its e2e tests are quick; a real CRM would poll every few minutes.
  interval: "10s",
  config: z.object({
    stage: ui(z.enum(DEAL_STAGES), { label: "Stage" }),
    days: ui(z.number().int().min(1), { label: "Days in stage" }).default(3),
  }),
  payload: z.object({ deal: DealSchema, days: z.number() }),
  poll: ({ config, since, until, ctx }) => ({
    items: ctx.services.crm
      .listDeals()
      // Eligibility: still in the stage now.
      .filter((d) => d.stage === config.stage)
      // Crossed the threshold in this interval.
      .filter((d) => {
        const due = Date.parse(d.stageEnteredAt) + config.days * DAY;
        return due > since && due <= until;
      })
      .map((d) => ({
        key: `${d.id}:${d.stageEnteredAt}`,
        payload: { deal: d, days: config.days },
      })),
  }),
});
