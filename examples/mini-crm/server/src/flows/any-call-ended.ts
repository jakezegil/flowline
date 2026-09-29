/**
 * The `any-call-ended` workflow: whichever system made the call (the AI agent or the phone
 * system), tell the contact's owner that it ended.
 *
 * @module
 */
import { ref, tpl, type WorkflowDoc, workflow } from "@flowlinejs/core";
import { and, conditionNode, isNotEmpty, stopNode, strictly } from "@flowlinejs/nodes-builtin";
import { callEnded, getContact, getUser, sendEmail } from "../plugin";
import { withStepNames } from "./names";

/** Calls shorter than this (a missed call, a voicemail greeting) start no run. */
export const MIN_CALL_SECONDS = 30;

/** Emails the owner of the contact on a call of at least {@link MIN_CALL_SECONDS}. */
export const anyCallEndedFlow: WorkflowDoc = withStepNames(
  workflow("any-call-ended", {
    name: "Any call ended",
    description: "Tell the contact's owner when an AI or VoIP call with the contact ends.",
  })
    .trigger(callEnded, { minSeconds: MIN_CALL_SECONDS })
    .step("contact", getContact, { contactId: ref("trigger.call.contactId") })
    .step(
      "has_owner",
      conditionNode,
      { rules: strictly(and(isNotEmpty(ref("steps.contact.contact.ownerId")))) },
      {
        if: (b) =>
          b
            .step("owner", getUser, { userId: ref("steps.contact.contact.ownerId") })
            .step("notify", sendEmail, {
              to: ref("steps.owner.user.email"),
              subject: tpl(
                "Call with {{steps.contact.contact.firstName}} {{steps.contact.contact.lastName}} ended",
              ),
              body: tpl(
                "Your contact's {{trigger.call.source}} call lasted {{trigger.call.durationSec}} seconds.\n\n{{trigger.call.summary}}",
              ),
            }),
        else: (b) => b.step("no_owner", stopNode, { reason: "No owner" }),
      },
    )
    .build(),
  {
    contact: "Load contact",
    has_owner: "Has an owner?",
    owner: "Load owner",
    notify: "Email owner",
    no_owner: "Stop: no owner",
  },
);
