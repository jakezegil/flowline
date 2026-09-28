// Stub for the guide's "./services".
export interface Contact {
  id: string;
  name: string;
  email: string;
  vip: boolean;
}

export interface Db {
  contacts: { get(id: string): Promise<Contact> };
  approvals: {
    create(
      approval: { approver: string; resumeUrl: string; key: string },
      opts: { signal: AbortSignal },
    ): Promise<void>;
  };
}

export interface Mailer {
  send(
    message: { to: string; subject: string; body?: string | undefined },
    opts: { idempotencyKey: string; signal: AbortSignal },
  ): Promise<{ messageId: string }>;
}
