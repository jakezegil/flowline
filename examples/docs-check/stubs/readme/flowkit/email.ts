// Stub for "./email" (the plugin guide defines the real crm.sendEmail).
import { defineNode } from "@flowkit/core";
import { z } from "zod";

export const sendEmail = defineNode({
  type: "crm.sendEmail",
  name: "Send email",
  input: z.object({ to: z.string(), subject: z.string() }),
  output: z.object({ messageId: z.string() }),
  run: () => ({ messageId: "m_1" }),
});
