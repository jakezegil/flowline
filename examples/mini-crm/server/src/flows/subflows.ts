/**
 * Reusable contact sub-flows. Each has a `core.subflow` trigger declaring its input and output,
 * so other workflows (and the editor's "Run sub-flow" step) can call it.
 *
 * @module
 */
import { ref, type WorkflowDoc, workflow } from "@flowline/core";
import {
  and,
  callSubflowNode,
  conditionNode,
  isFalse,
  subflowTrigger,
} from "@flowline/nodes-builtin";
import { createContact, findContactByEmail } from "../plugin";
import { withStepNames } from "./names";

/** Looks a contact up by email: `{ email }` → `{ found, contact }`. */
export const getContactFlow: WorkflowDoc = withStepNames(
  workflow("get-contact", {
    name: "Get contact",
    description: "Find a contact by email.",
  })
    .trigger(subflowTrigger, {
      input: [{ name: "email", type: "string", required: true }],
      output: [
        { name: "found", type: "boolean", required: true },
        { name: "contact", type: "object", description: "The contact, when found." },
      ],
    })
    .step("find", findContactByEmail, { email: ref("trigger.email") })
    .output({ found: ref("steps.find.found"), contact: ref("steps.find.contact") })
    .build(),
  { find: "Find by email" },
);

/** Creates a contact: contact fields → `{ contact }`. */
export const createContactFlow: WorkflowDoc = withStepNames(
  workflow("create-contact", {
    name: "Create contact",
    description: "Add a contact to the CRM.",
  })
    .trigger(subflowTrigger, {
      input: [
        { name: "email", type: "string", required: true },
        { name: "firstName", type: "string", required: true },
        { name: "lastName", type: "string", required: true },
        { name: "company", type: "string" },
        { name: "source", type: "string" },
      ],
      output: [{ name: "contact", type: "object", required: true }],
    })
    .step("create", createContact, {
      email: ref("trigger.email"),
      firstName: ref("trigger.firstName"),
      lastName: ref("trigger.lastName"),
      company: ref("trigger.company"),
      source: ref("trigger.source"),
    })
    .output({ contact: ref("steps.create.contact") })
    .build(),
  { create: "Create contact" },
);

/**
 * Finds the contact with the email, creating it first when there is none:
 * contact fields → `{ contact, created }`.
 *
 * Steps inside a branch are not visible after the branch rejoins (spec §4.4), so the `create`
 * step's output cannot be used below the condition. Instead the flow looks the contact up again
 * (`reload`), which now always finds it.
 */
export const getOrCreateContactFlow: WorkflowDoc = withStepNames(
  workflow("get-or-create-contact", {
    name: "Get or create contact",
    description: "Find a contact by email, creating it when it does not exist yet.",
  })
    .trigger(subflowTrigger, {
      input: [
        { name: "email", type: "string", required: true },
        { name: "firstName", type: "string", required: true },
        { name: "lastName", type: "string", required: true },
        { name: "company", type: "string" },
        { name: "source", type: "string" },
      ],
      output: [
        { name: "contact", type: "object", required: true },
        { name: "created", type: "boolean", required: true },
      ],
    })
    .step("lookup", callSubflowNode, {
      workflowId: "get-contact",
      input: { email: ref("trigger.email") },
    })
    .step(
      "check",
      conditionNode,
      { rules: and(isFalse(ref("steps.lookup.found"))) },
      {
        if: (b) =>
          b.step("create", callSubflowNode, {
            workflowId: "create-contact",
            input: {
              email: ref("trigger.email"),
              firstName: ref("trigger.firstName"),
              lastName: ref("trigger.lastName"),
              company: ref("trigger.company"),
              source: ref("trigger.source"),
            },
          }),
        else: (b) => b,
      },
    )
    .step("reload", findContactByEmail, { email: ref("trigger.email") })
    .output({ contact: ref("steps.reload.contact"), created: ref("steps.check.matched") })
    .build(),
  {
    lookup: "Look up contact",
    check: "Not in the CRM?",
    create: "Create contact",
    reload: "Load contact",
  },
);
