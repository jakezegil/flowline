/**
 * The `crm.sendEmail` node.
 *
 * @module
 */
import { defineNode, ui } from "@flowkit/core";
import { z } from "zod";

/**
 * Sends an email through the CRM's outbox. Steps run at least once, so the step's
 * `ctx.idempotencyKey` goes with the message: a re-run step finds the message already sent and
 * sends nothing new.
 */
export const sendEmail = defineNode({
  type: "crm.sendEmail",
  name: "Send email",
  description: "Send an email from the CRM.",
  icon: "mail",
  category: "Email",
  summary: "Email {{to}}: {{subject}}",
  input: z.object({
    to: ui(z.string().min(1, "Enter a recipient"), {
      label: "To",
      placeholder: "grace@example.com",
    }),
    subject: ui(z.string().min(1, "Enter a subject"), { label: "Subject" }),
    body: ui(z.string(), { label: "Body", multiline: true }),
  }),
  output: z.object({
    messageId: z.string().describe("ID of the message in the outbox."),
    deduped: z.boolean().describe("Whether this step had already sent it."),
  }),
  // The outbox cannot fail transiently. A real mail provider can: throw `RetryableError` for a
  // 429 or 5xx (the engine retries the step), and `FatalError` for a rejected address.
  run: ({ input, ctx }) => {
    const { message, deduped } = ctx.services.crm.sendEmail({
      ...input,
      idempotencyKey: ctx.idempotencyKey,
      runId: ctx.runId,
      workflowId: ctx.workflowId,
    });
    return { messageId: message.id, deduped };
  },
});
