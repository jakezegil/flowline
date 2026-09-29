/**
 * User nodes of the `crm` plugin.
 *
 * @module
 */
import { defineNode, FatalError } from "@flowlinejs/core";
import { z } from "zod";
import { UserSchema } from "../crm-store";
import { userId } from "./contacts";

/** Loads a CRM user (a rep or a manager) by ID. Fails the step when the user does not exist. */
export const getUser = defineNode({
  type: "crm.getUser",
  name: "Get user",
  description: "Load a sales rep or manager by user ID, for example a deal's owner.",
  icon: "user",
  category: "Users",
  summary: "Get user {{userId}}",
  input: z.object({ userId: userId("User") }),
  output: z.object({ user: UserSchema }),
  run: ({ input, ctx }) => {
    const user = ctx.services.crm.getUser(input.userId);
    if (!user) throw new FatalError(`User "${input.userId}" not found`);
    return { user };
  },
});
