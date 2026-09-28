/**
 * The `inbound-lead-routing` workflow: a lead arrives by webhook, becomes (or matches) a contact,
 * gets an owner by lead source, and big companies need a manager's approval.
 *
 * @module
 */
import { ref, tpl, type WorkflowDoc, workflow } from "@flowline/core";
import {
  and,
  callSubflowNode,
  conditionNode,
  gte,
  stopNode,
  switchNode,
  webhookTrigger,
} from "@flowline/nodes-builtin";
import { assignOwner, getContact, requestApproval, sendEmail } from "../plugin";
import { withStepNames } from "./names";

/** The manager who approves enterprise leads. */
export const LEAD_APPROVER_ID = "u_ava";
/** Companies with at least this many employees need approval. */
export const ENTERPRISE_EMPLOYEES = 500;

const contactId = ref("steps.lead.contact.id");

/** Routes inbound leads (see the module docs). Repeated `X-Request-Id` values start no new run. */
export const inboundLeadRoutingFlow: WorkflowDoc = withStepNames(
  workflow("inbound-lead-routing", {
    name: "Inbound lead routing",
    description: "Turn inbound leads into contacts, assign an owner and escalate enterprise leads.",
  })
    .trigger(webhookTrigger, {
      fields: [
        { name: "email", type: "string", required: true },
        { name: "firstName", type: "string", required: true },
        { name: "lastName", type: "string", required: true },
        { name: "company", type: "string" },
        { name: "source", type: "string", description: "web, referral or event" },
        { name: "employees", type: "number", description: "Company size" },
      ],
      dedupeHeader: "X-Request-Id",
    })
    .step("lead", callSubflowNode, {
      workflowId: "get-or-create-contact",
      input: {
        email: ref("trigger.body.email"),
        firstName: ref("trigger.body.firstName"),
        lastName: ref("trigger.body.lastName"),
        company: ref("trigger.body.company"),
        source: ref("trigger.body.source"),
      },
    })
    .step(
      "route",
      switchNode,
      {
        value: ref("trigger.body.source"),
        cases: [
          { id: "web", label: "Web", value: "web" },
          { id: "referral", label: "Referral", value: "referral" },
          { id: "event", label: "Event", value: "event" },
        ],
      },
      {
        web: (b) => b.step("assign_web", assignOwner, { contactId, strategy: "team", team: "smb" }),
        referral: (b) =>
          b.step("assign_referral", assignOwner, {
            contactId,
            strategy: "team",
            team: "enterprise",
          }),
        event: (b) => b.step("assign_event", assignOwner, { contactId, strategy: "roundRobin" }),
        default: (b) =>
          b.step("assign_default", assignOwner, { contactId, strategy: "roundRobin" }),
      },
    )
    // The assign steps sit inside the switch's branches, so they are out of scope here: load the
    // contact again to get the owner that was just assigned.
    .step("owned", getContact, { contactId })
    .step(
      "size",
      conditionNode,
      { rules: and(gte(ref("trigger.body.employees"), ENTERPRISE_EMPLOYEES)) },
      {
        if: (b) =>
          b.step(
            "approval",
            requestApproval,
            {
              title: tpl(
                "Enterprise lead: {{trigger.body.company}} ({{trigger.body.employees}} employees)",
              ),
              approverId: LEAD_APPROVER_ID,
            },
            {
              approved: (a) =>
                a.step("notify_owner", sendEmail, {
                  to: ref("steps.owned.owner.email"),
                  subject: "Enterprise lead approved",
                  body: tpl(
                    "{{trigger.body.firstName}} {{trigger.body.lastName}} from {{trigger.body.company}} ({{trigger.body.email}}) is yours. Reach out today!",
                  ),
                }),
              rejected: (a) => a.step("rejected", stopNode, { reason: "Rejected by manager" }),
            },
          ),
        else: (b) =>
          b.step("welcome", sendEmail, {
            to: ref("trigger.body.email"),
            subject: "Welcome to Acme",
            body: tpl(
              "Hi {{trigger.body.firstName}},\n\nThanks for your interest in Acme. {{steps.owned.owner.name}} will be in touch shortly.",
            ),
          }),
      },
    )
    .build(),
  {
    lead: "Get or create contact",
    route: "Route by source",
    assign_web: "Assign SMB owner",
    assign_referral: "Assign enterprise owner",
    assign_event: "Assign next rep",
    assign_default: "Assign next rep",
    owned: "Load new owner",
    size: "Enterprise lead?",
    approval: "Manager approval",
    notify_owner: "Notify owner",
    rejected: "Stop: rejected",
    welcome: "Send welcome email",
  },
);
