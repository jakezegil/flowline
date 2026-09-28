// Stub for the README's "../vault": one tenant secret, the webhook's signing key.
export const WEBHOOK_KEY = "whsec_docs_check";

export const vault = {
  get: async (_tenantId: string, name: string): Promise<string | undefined> =>
    name === "partner-webhook" ? WEBHOOK_KEY : undefined,
};
