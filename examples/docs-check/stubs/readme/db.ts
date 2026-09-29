// Stub for the README's "../db": a deterministic contact store.
export interface Contact {
  id: string;
  name: string;
  email: string;
  vip: boolean;
}

export interface Deal {
  id: string;
  name: string;
  stage: string;
  /** ISO instant the deal entered `stage`. */
  stageEnteredAt: string;
}

export interface Db {
  contacts: { get(id: string): Promise<Contact> };
  approvals: {
    create(
      approval: { approver: string; resumeUrl: string; key: string },
      opts: { signal: AbortSignal },
    ): Promise<void>;
  };
  deals: { inStage(stage: string): Promise<Deal[]> };
}

export const db: Db = {
  contacts: { get: async (id) => ({ id, name: "Ada", email: "ada@example.com", vip: true }) },
  approvals: { create: async () => {} },
  deals: { inStage: async () => [] },
};
