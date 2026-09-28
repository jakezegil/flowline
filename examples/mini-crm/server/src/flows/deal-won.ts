/**
 * The `deal-won-follow-up` workflow: when a big deal is won, wait a moment, then thank the
 * customer with an email composed by a transform step.
 *
 * @module
 */
import { ref, type WorkflowDoc, workflow } from "@flowline/core";
import {
  and,
  conditionNode,
  delayNode,
  gte,
  stopNode,
  transformNode,
} from "@flowline/nodes-builtin";
import { dealUpdated, getContact, sendEmail } from "../plugin";
import { withStepNames } from "./names";

/** Deals below this amount get no follow-up. */
export const BIG_DEAL_AMOUNT = 10_000;

const COMPOSE = `const deal = trigger.deal;
const contact = steps.customer.contact;
const amount = "$" + String(deal.amount).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
return {
  subject: "Thank you, " + contact.firstName + ": " + deal.name + " is confirmed",
  body:
    "Hi " + contact.firstName + ",\\n\\n" +
    "Thank you for choosing Acme for " + deal.name + " (" + amount + "). " +
    "Your onboarding starts this week.\\n\\nThe Acme team",
};`;

/** Thanks the customer of a won deal of at least {@link BIG_DEAL_AMOUNT}. */
export const dealWonFollowUpFlow: WorkflowDoc = withStepNames(
  workflow("deal-won-follow-up", {
    name: "Deal won follow-up",
    description: "Thank the customer a minute after a big deal is won.",
  })
    .trigger(dealUpdated, { onlyWhenStageChanges: true, stage: "won" })
    .step(
      "size",
      conditionNode,
      { rules: and(gte(ref("trigger.deal.amount"), BIG_DEAL_AMOUNT)) },
      {
        if: (b) => b,
        else: (b) => b.step("small_deal", stopNode, { reason: "Small deal" }),
      },
    )
    // One minute keeps the demo quick; a real follow-up would wait a day or two.
    .step("wait", delayNode, { duration: "1m" })
    .step("customer", getContact, { contactId: ref("trigger.deal.contactId") })
    .step("compose", transformNode, {
      code: COMPOSE,
      outputFields: [
        { name: "subject", type: "string", required: true },
        { name: "body", type: "string", required: true },
      ],
    })
    .step("thank_you", sendEmail, {
      to: ref("steps.customer.contact.email"),
      subject: ref("steps.compose.subject"),
      body: ref("steps.compose.body"),
    })
    .build(),
  {
    size: "Big deal?",
    small_deal: "Stop: small deal",
    wait: "Wait a minute",
    customer: "Load customer",
    compose: "Write thank-you",
    thank_you: "Email customer",
  },
);
