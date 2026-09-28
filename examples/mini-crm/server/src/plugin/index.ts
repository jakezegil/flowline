/**
 * The `crm` plugin: the mini CRM's own nodes and triggers. This is what a host app writes to put
 * its domain into Flowline.
 *
 * @module
 */
import { definePlugin, type PluginDefinition } from "@flowlinejs/core";
import type { CrmStore } from "../crm-store";
import { requestApproval } from "./approval";
import {
  assignOwner,
  createContact,
  findContactByEmail,
  getContact,
  updateContact,
} from "./contacts";
import { updateDeal } from "./deals";
import { sendEmail } from "./email";
import { contactCreated, dealUpdated } from "./triggers";

declare module "@flowlinejs/core" {
  interface FlowlineServices {
    /** The mini CRM's store, available to handlers as `ctx.services.crm`. */
    crm: CrmStore;
  }
}

export { approvalIdFor, REQUEST_APPROVAL, requestApproval, restoreApprovals } from "./approval";
export {
  assignOwner,
  createContact,
  findContactByEmail,
  getContact,
  updateContact,
} from "./contacts";
export { updateDeal } from "./deals";
export { sendEmail } from "./email";
export { contactCreated, dealUpdated } from "./triggers";

/** The `crm` plugin. User ID fields use the `crm.userSelect` widget, which the web app provides. */
export const crmPlugin: PluginDefinition = definePlugin({
  id: "crm",
  name: "Mini CRM",
  icon: "building-2",
  description: "Contacts, deals, email and approvals from the mini CRM.",
  nodes: [
    findContactByEmail,
    getContact,
    createContact,
    updateContact,
    assignOwner,
    updateDeal,
    sendEmail,
    requestApproval,
  ],
  triggers: [contactCreated, dealUpdated],
});
