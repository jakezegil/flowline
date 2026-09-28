/**
 * Contact nodes of the `crm` plugin.
 *
 * @module
 */
import { defineNode, FatalError, ui } from "@flowkit/core";
import { z } from "zod";
import { ContactSchema, CrmError, TEAMS, UserSchema } from "../crm-store";

/** A user ID field, rendered by the host's `crm.userSelect` widget. */
export const userId = (label: string) => ui(z.string().min(1), { label, widget: "crm.userSelect" });

/** A contact ID field. */
const contactId = () =>
  ui(z.string().min(1, "Choose a contact"), { label: "Contact ID", placeholder: "c_1" });

/**
 * Run a store call, turning a {@link CrmError} into a {@link FatalError}: an unknown ID or an
 * invalid value will not fix itself on retry. Any other error is rethrown unchanged, so the
 * engine retries the step with its retry policy. A store talking to a real database or API would
 * throw `RetryableError` for transient failures (timeouts, 429, 503) to make that explicit.
 */
export async function crmCall<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CrmError) throw new FatalError(err.message);
    throw err;
  }
}

/** Looks a contact up by email; `found` says whether one exists. */
export const findContactByEmail = defineNode({
  type: "crm.findContactByEmail",
  name: "Find contact by email",
  description: "Look up a contact by email address. Found is false when there is none.",
  icon: "search",
  category: "Contacts",
  summary: "Find contact {{email}}",
  input: z.object({
    email: ui(z.string().min(1, "Enter an email"), {
      label: "Email",
      placeholder: "grace@example.com",
    }),
  }),
  output: z.object({
    found: z.boolean().describe("Whether a contact has this email."),
    contact: ContactSchema.optional().describe("The contact, when found."),
  }),
  run: ({ input, ctx }) => {
    const contact = ctx.services.crm.findContactByEmail(input.email);
    return contact ? { found: true, contact } : { found: false };
  },
});

/** Loads a contact by ID, with its owner. Fails the step when the contact does not exist. */
export const getContact = defineNode({
  type: "crm.getContact",
  name: "Get contact",
  description: "Load a contact and its owner by contact ID.",
  icon: "contact",
  category: "Contacts",
  summary: "Get contact {{contactId}}",
  input: z.object({ contactId: contactId() }),
  output: z.object({
    contact: ContactSchema,
    owner: UserSchema.optional().describe("The owning user; absent when unassigned."),
  }),
  run: ({ input, ctx }) => {
    const { crm } = ctx.services;
    const contact = crm.getContact(input.contactId);
    if (!contact) throw new FatalError(`Contact "${input.contactId}" not found`);
    const owner = contact.ownerId ? crm.getUser(contact.ownerId) : undefined;
    return owner ? { contact, owner } : { contact };
  },
});

const contactFields = {
  firstName: ui(z.string(), { label: "First name" }),
  lastName: ui(z.string(), { label: "Last name" }),
  email: ui(z.string().min(1, "Enter an email"), { label: "Email" }),
  company: ui(z.string(), { label: "Company" }).optional(),
  source: ui(z.string(), { label: "Source", placeholder: "web" }).optional(),
};

/**
 * Creates a contact. Re-running the step (at-least-once execution) creates it only once. When a
 * contact with the email exists already (e.g. two runs for the same lead raced past their
 * lookups), that contact is returned instead of failing the step.
 */
export const createContact = defineNode({
  type: "crm.createContact",
  name: "Create contact",
  description: "Add a new contact to the CRM.",
  icon: "user-plus",
  category: "Contacts",
  summary: "Create contact {{email}}",
  input: z.object({ ...contactFields, ownerId: userId("Owner").optional() }),
  output: z.object({ contact: ContactSchema }),
  run: async ({ input, ctx }) => {
    const { crm } = ctx.services;
    try {
      return { contact: await crm.createContact(input, { idempotencyKey: ctx.idempotencyKey }) };
    } catch (err) {
      const existing = err instanceof CrmError && err.status === 409;
      const contact = existing ? crm.findContactByEmail(input.email) : undefined;
      if (contact) return { contact };
      if (err instanceof CrmError) throw new FatalError(err.message);
      throw err;
    }
  },
});

/** Changes fields of a contact; fields left empty keep their value. */
export const updateContact = defineNode({
  type: "crm.updateContact",
  name: "Update contact",
  description: "Change a contact's details or owner. Fields left empty are not changed.",
  icon: "user-pen",
  category: "Contacts",
  summary: "Update contact {{contactId}}",
  input: z.object({
    contactId: contactId(),
    firstName: contactFields.firstName.optional(),
    lastName: contactFields.lastName.optional(),
    email: ui(z.string(), { label: "Email" }).optional(),
    company: contactFields.company,
    source: contactFields.source,
    ownerId: userId("Owner").optional(),
  }),
  output: z.object({ contact: ContactSchema }),
  run: async ({ input, ctx }) => {
    const { contactId: id, ...changes } = input;
    return { contact: await crmCall(() => ctx.services.crm.updateContact(id, changes)) };
  },
});

/** Picks an owner for a contact (round robin over all reps, or within a team) and assigns it. */
export const assignOwner = defineNode({
  type: "crm.assignOwner",
  name: "Assign owner",
  description:
    "Pick a sales rep for the contact and make them its owner. Round robin rotates through every rep; Team rotates through one team's reps.",
  icon: "user-check",
  category: "Contacts",
  summary: "Round robin",
  input: z
    .object({
      contactId: contactId(),
      strategy: ui(z.enum(["roundRobin", "team"]), { label: "Strategy" }).default("roundRobin"),
      team: ui(z.enum(TEAMS), {
        label: "Team",
        enumLabels: { smb: "SMB", enterprise: "Enterprise" },
        showIf: { field: "strategy", equals: "team" },
      })
        .describe("Whose reps the Team strategy rotates through.")
        .optional(),
    })
    .refine((v) => v.strategy !== "team" || v.team !== undefined, {
      message: "Choose a team for the Team strategy",
      path: ["team"],
    }),
  output: UserSchema,
  run: ({ input, ctx }) =>
    crmCall(() =>
      ctx.services.crm.assignOwner(input.contactId, {
        strategy: input.strategy,
        ...(input.team ? { team: input.team } : {}),
        idempotencyKey: ctx.idempotencyKey,
      }),
    ),
});
