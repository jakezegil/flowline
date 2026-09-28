/**
 * The mini CRM's data: an in-memory store of contacts, deals, users, sent emails (the outbox) and
 * approval requests, seeded with demo data. It stands in for a real CRM's database.
 *
 * The store knows nothing about Flowkit. It reports changes (`contact.created`, `deal.updated`)
 * to the listener the app registers with {@link CrmStore.onEvent}, which turns them into
 * `engine.emit` calls.
 *
 * @module
 */
import { z } from "zod";

/** Deal pipeline stages, in order. */
export const DEAL_STAGES = ["lead", "qualified", "proposal", "won", "lost"] as const;
/** A deal's stage. */
export type DealStage = (typeof DEAL_STAGES)[number];
/** Sales teams. */
export const TEAMS = ["smb", "enterprise"] as const;
/** A sales team. */
export type Team = (typeof TEAMS)[number];

/** Zod schema of a {@link Contact}. */
export const ContactSchema = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  company: z.string(),
  source: z.string(),
  ownerId: z.string().nullable().describe("ID of the owning user, or null when unassigned."),
  createdAt: z.iso.datetime(),
});
/** A person the sales team talks to. */
export type Contact = z.infer<typeof ContactSchema>;

/** Zod schema of a {@link Deal}. */
export const DealSchema = z.object({
  id: z.string(),
  name: z.string(),
  amount: z.number(),
  stage: z.enum(DEAL_STAGES),
  contactId: z.string(),
  ownerId: z.string(),
});
/** A sales opportunity. */
export type Deal = z.infer<typeof DealSchema>;

/** Zod schema of a {@link User}. */
export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(["rep", "manager"]),
  team: z.enum(TEAMS),
});
/** A CRM user: a sales rep or a manager. */
export type User = z.infer<typeof UserSchema>;

/** Zod schema of an {@link OutboxMessage}. */
export const OutboxMessageSchema = z.object({
  id: z.string(),
  to: z.string(),
  subject: z.string(),
  body: z.string(),
  sentAt: z.iso.datetime(),
  idempotencyKey: z.string(),
});
/** An email the CRM "sent" (recorded, never delivered). */
export type OutboxMessage = z.infer<typeof OutboxMessageSchema>;

/** State of an approval request. `expired` means it timed out undecided. */
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

/**
 * An approval request as the API shows it. The callback token that resumes the waiting run stays
 * inside the store and is never part of this record.
 */
export interface Approval {
  /** Approval ID, stable for the workflow step that requested it. */
  id: string;
  /** The run waiting for the decision. */
  runId: string;
  /** What needs approving. */
  title: string;
  /** The user asked to decide. */
  approverId: string;
  /** Current state. */
  status: ApprovalStatus;
  /** When it was requested (ISO 8601). */
  createdAt: string;
  /** When it was decided or expired (ISO 8601), or `null` while pending. */
  decidedAt: string | null;
}

/** Fields accepted when creating a contact. */
export interface NewContact {
  /** First name. */
  firstName: string;
  /** Last name. */
  lastName: string;
  /** Email address; unique across contacts (case-insensitive). */
  email: string;
  /** Company name. Default `""`. */
  company?: string;
  /** Lead source, e.g. `web`. Default `""`. */
  source?: string;
  /** Owning user ID. Default `null` (unassigned). */
  ownerId?: string | null;
}

/** Fields that can be changed on a contact. */
export type ContactChanges = Partial<Omit<Contact, "id" | "createdAt">>;
/** Fields that can be changed on a deal. */
export type DealChanges = Partial<Pick<Deal, "stage" | "amount" | "ownerId" | "name">>;

/** A change the CRM reports to its listener. `id` is unique per event (use it to deduplicate). */
export type CrmEvent =
  | { id: string; type: "contact.created"; payload: { contact: Contact } }
  | { id: string; type: "deal.updated"; payload: { deal: Deal; changes: string[] } };

/** Receives CRM events; the store awaits it, so a returned promise delays the mutation's result. */
export type CrmListener = (event: CrmEvent) => void | Promise<void>;

/** Thrown for a request the CRM cannot satisfy (unknown ID, invalid value). */
export class CrmError extends Error {
  override readonly name = "CrmError";
  /** @param status - See {@link CrmError.status}. */
  constructor(
    message: string,
    /** HTTP-style status: 404 for unknown records, 400 for invalid input, 409 for conflicts. */
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

interface StoredApproval extends Approval {
  /** Resumes the waiting run through `engine.resume`. Never leaves the store. */
  token: string;
}

interface State {
  contacts: Map<string, Contact>;
  deals: Map<string, Deal>;
  users: Map<string, User>;
  outbox: OutboxMessage[];
  approvals: Map<string, StoredApproval>;
  /** Idempotency key → contact ID, so a re-run `crm.createContact` step creates one contact. */
  createdByKey: Map<string, string>;
  /** Idempotency key → user ID, so a re-run `crm.assignOwner` step picks the same owner. */
  assignedByKey: Map<string, string>;
  /** Round-robin cursor per pool (`"all"` or a team). */
  cursors: Map<string, number>;
  nextContact: number;
  nextMessage: number;
}

const SEED_USERS: User[] = [
  { id: "u_ava", name: "Ava Chen", email: "ava@acme.test", role: "manager", team: "enterprise" },
  { id: "u_ben", name: "Ben Ortiz", email: "ben@acme.test", role: "rep", team: "smb" },
  { id: "u_cara", name: "Cara Singh", email: "cara@acme.test", role: "rep", team: "smb" },
  { id: "u_dev", name: "Dev Patel", email: "dev@acme.test", role: "rep", team: "enterprise" },
  { id: "u_eli", name: "Eli Brooks", email: "eli@acme.test", role: "rep", team: "enterprise" },
];

const SEED_CONTACTS: Omit<Contact, "createdAt">[] = [
  ["Grace", "Hopper", "grace@navy.test", "Navy Labs", "referral", "u_dev"],
  ["Alan", "Turing", "alan@bletchley.test", "Bletchley", "event", "u_eli"],
  ["Ada", "Lovelace", "ada@engines.test", "Analytical Engines", "web", "u_ben"],
  ["Linus", "Torvalds", "linus@kernel.test", "Kernel Co", "web", "u_cara"],
  ["Margaret", "Hamilton", "margaret@apollo.test", "Apollo Systems", "referral", "u_dev"],
  ["Ken", "Thompson", "ken@unix.test", "Unix Works", "event", "u_ben"],
  ["Barbara", "Liskov", "barbara@clu.test", "CLU Partners", "web", "u_eli"],
  ["Donald", "Knuth", "don@tex.test", "TeX Press", "referral", "u_cara"],
  ["Radia", "Perlman", "radia@spanning.test", "Spanning Tree", "event", null],
  ["Dennis", "Ritchie", "dennis@bell.test", "Bell Labs", "web", "u_ben"],
  ["Frances", "Allen", "frances@ibm.test", "Optimizing Inc", "referral", "u_dev"],
  ["Tim", "Berners-Lee", "tim@cern.test", "CERN Web", "web", null],
].map(([firstName, lastName, email, company, source, ownerId], i) => ({
  id: `c_${i + 1}`,
  firstName: firstName as string,
  lastName: lastName as string,
  email: email as string,
  company: company as string,
  source: source as string,
  ownerId: ownerId ?? null,
}));

const SEED_DEALS: Deal[] = [
  {
    id: "d_1",
    name: "Navy Labs expansion",
    amount: 48_000,
    stage: "proposal",
    contactId: "c_1",
    ownerId: "u_dev",
  },
  {
    id: "d_2",
    name: "Bletchley pilot",
    amount: 12_500,
    stage: "qualified",
    contactId: "c_2",
    ownerId: "u_eli",
  },
  {
    id: "d_3",
    name: "Analytical Engines starter",
    amount: 2_400,
    stage: "lead",
    contactId: "c_3",
    ownerId: "u_ben",
  },
  {
    id: "d_4",
    name: "Kernel Co seats",
    amount: 6_000,
    stage: "proposal",
    contactId: "c_4",
    ownerId: "u_cara",
  },
  {
    id: "d_5",
    name: "Apollo Systems platform",
    amount: 96_000,
    stage: "qualified",
    contactId: "c_5",
    ownerId: "u_dev",
  },
  {
    id: "d_6",
    name: "Unix Works renewal",
    amount: 8_000,
    stage: "won",
    contactId: "c_6",
    ownerId: "u_ben",
  },
  {
    id: "d_7",
    name: "CLU Partners rollout",
    amount: 30_000,
    stage: "lead",
    contactId: "c_7",
    ownerId: "u_eli",
  },
  {
    id: "d_8",
    name: "TeX Press add-on",
    amount: 1_200,
    stage: "lost",
    contactId: "c_8",
    ownerId: "u_cara",
  },
];

/** The CRM's store API. */
export interface CrmStore {
  /** Register the listener for CRM events (one; a later call replaces it). */
  onEvent(listener: CrmListener): void;
  /** Restore the seed data: contacts, deals and users as seeded, empty outbox and approvals. */
  reset(): void;

  /** All contacts, newest first. */
  listContacts(): Contact[];
  /** The contact with this ID, if any. */
  getContact(id: string): Contact | undefined;
  /** The contact with this email (case-insensitive), if any. */
  findContactByEmail(email: string): Contact | undefined;
  /**
   * Create a contact and report `contact.created`. With `idempotencyKey`, repeated calls with the
   * same key return the first call's contact and report nothing.
   * @throws {@link CrmError} 409 when another contact already has the email.
   */
  createContact(fields: NewContact, opts?: { idempotencyKey?: string }): Promise<Contact>;
  /** Change a contact. @throws {@link CrmError} 404 for an unknown contact or owner. */
  updateContact(id: string, changes: ContactChanges): Contact;
  /**
   * Pick an owner for a contact and assign it. `roundRobin` cycles through every rep, `team`
   * through the reps of `team`. With `idempotencyKey`, repeated calls pick the same owner.
   */
  assignOwner(
    contactId: string,
    opts: { strategy: "roundRobin" | "team"; team?: Team; idempotencyKey?: string },
  ): User;

  /** All deals. */
  listDeals(): Deal[];
  /** The deal with this ID, if any. */
  getDeal(id: string): Deal | undefined;
  /**
   * Change a deal and report `deal.updated` with the names of the fields that actually changed
   * (nothing is reported when nothing changed).
   */
  updateDeal(id: string, changes: DealChanges): Promise<{ deal: Deal; changes: string[] }>;

  /** All users. */
  listUsers(): User[];
  /** The user with this ID, if any. */
  getUser(id: string): User | undefined;

  /** Sent emails, newest first. */
  listOutbox(): OutboxMessage[];
  /**
   * Record an email. A second call with the same `idempotencyKey` returns the first message
   * instead of sending again.
   */
  sendEmail(msg: { to: string; subject: string; body: string; idempotencyKey: string }): {
    message: OutboxMessage;
    deduped: boolean;
  };

  /** Approval requests, newest first (without their tokens). */
  listApprovals(): Approval[];
  /** The approval with this ID (without its token), if any. */
  getApproval(id: string): Approval | undefined;
  /**
   * Record a pending approval, or refresh a pending one's token (a re-run step issues a new
   * callback). A decided approval is left as is.
   */
  upsertApproval(a: {
    id: string;
    runId: string;
    title: string;
    approverId: string;
    token: string;
  }): Approval;
  /** The token that resumes a pending approval's run; `undefined` once decided. */
  approvalToken(id: string): string | undefined;
  /** Mark an approval decided (or expired). Already decided approvals keep their first outcome. */
  settleApproval(id: string, status: Exclude<ApprovalStatus, "pending">): Approval | undefined;
  /** Mark an approval expired, whatever its state: its run no longer waits for a decision. */
  expireApproval(id: string): Approval | undefined;
}

function publicApproval({ token: _token, ...approval }: StoredApproval): Approval {
  return { ...approval };
}

/**
 * Create a CRM store seeded with 12 contacts, 8 deals and 5 users.
 *
 * @param opts.clock - Time source in epoch ms (default `Date.now`); share the engine's clock.
 */
export function createCrmStore(opts: { clock?: () => number } = {}): CrmStore {
  const clock = opts.clock ?? Date.now;
  const iso = () => new Date(clock()).toISOString();
  let listener: CrmListener | undefined;
  let state: State;

  const seed = (): State => {
    const at = iso();
    return {
      contacts: new Map(SEED_CONTACTS.map((c) => [c.id, { ...c, createdAt: at }])),
      deals: new Map(SEED_DEALS.map((d) => [d.id, { ...d }])),
      users: new Map(SEED_USERS.map((u) => [u.id, { ...u }])),
      outbox: [],
      approvals: new Map(),
      createdByKey: new Map(),
      assignedByKey: new Map(),
      cursors: new Map(),
      nextContact: SEED_CONTACTS.length + 1,
      nextMessage: 1,
    };
  };
  state = seed();

  const report = async (event: Omit<CrmEvent, "id">): Promise<void> => {
    await listener?.({ ...event, id: `evt_${globalThis.crypto.randomUUID()}` } as CrmEvent);
  };

  const requireContact = (id: string): Contact => {
    const c = state.contacts.get(id);
    if (!c) throw new CrmError(`Contact "${id}" not found`, 404);
    return c;
  };
  const requireUser = (id: string): User => {
    const u = state.users.get(id);
    if (!u) throw new CrmError(`User "${id}" not found`, 404);
    return u;
  };
  const newestFirst = <T>(items: Iterable<T>): T[] => [...items].reverse();

  const store: CrmStore = {
    onEvent(l) {
      listener = l;
    },
    reset() {
      state = seed();
    },

    listContacts: () => newestFirst(state.contacts.values()).map((c) => ({ ...c })),
    getContact: (id) => {
      const c = state.contacts.get(id);
      return c && { ...c };
    },
    findContactByEmail(email) {
      const wanted = email.trim().toLowerCase();
      const c = [...state.contacts.values()].find((x) => x.email.toLowerCase() === wanted);
      return c && { ...c };
    },
    async createContact(fields, { idempotencyKey } = {}) {
      const previous = idempotencyKey && state.createdByKey.get(idempotencyKey);
      if (previous) return { ...requireContact(previous) };
      const email = fields.email.trim();
      if (email === "") throw new CrmError("A contact needs an email", 400);
      if (store.findContactByEmail(email)) {
        throw new CrmError(`A contact with email "${email}" already exists`, 409);
      }
      if (fields.ownerId) requireUser(fields.ownerId);
      const contact: Contact = {
        id: `c_${state.nextContact++}`,
        firstName: fields.firstName,
        lastName: fields.lastName,
        email,
        company: fields.company ?? "",
        source: fields.source ?? "",
        ownerId: fields.ownerId ?? null,
        createdAt: iso(),
      };
      state.contacts.set(contact.id, contact);
      if (idempotencyKey) state.createdByKey.set(idempotencyKey, contact.id);
      await report({ type: "contact.created", payload: { contact: { ...contact } } });
      return { ...contact };
    },
    updateContact(id, changes) {
      const contact = requireContact(id);
      if (changes.ownerId) requireUser(changes.ownerId);
      const updated = { ...contact, ...changes, id, createdAt: contact.createdAt };
      state.contacts.set(id, updated);
      return { ...updated };
    },
    assignOwner(contactId, { strategy, team, idempotencyKey }) {
      requireContact(contactId);
      const previous = idempotencyKey && state.assignedByKey.get(idempotencyKey);
      let owner: User;
      if (previous) {
        owner = requireUser(previous);
      } else {
        if (strategy === "team" && team === undefined) {
          throw new CrmError("The team strategy needs a team", 400);
        }
        const pool = strategy === "team" ? (team as Team) : "all";
        const reps = [...state.users.values()].filter(
          (u) => u.role === "rep" && (pool === "all" || u.team === pool),
        );
        if (reps.length === 0) throw new CrmError(`No reps in pool "${pool}"`, 409);
        const cursor = state.cursors.get(pool) ?? 0;
        owner = reps[cursor % reps.length] as User;
        state.cursors.set(pool, cursor + 1);
        if (idempotencyKey) state.assignedByKey.set(idempotencyKey, owner.id);
      }
      store.updateContact(contactId, { ownerId: owner.id });
      return { ...owner };
    },

    listDeals: () => [...state.deals.values()].map((d) => ({ ...d })),
    getDeal: (id) => {
      const d = state.deals.get(id);
      return d && { ...d };
    },
    async updateDeal(id, changes) {
      const deal = state.deals.get(id);
      if (!deal) throw new CrmError(`Deal "${id}" not found`, 404);
      if (changes.stage !== undefined && !DEAL_STAGES.includes(changes.stage)) {
        throw new CrmError(`Unknown stage "${changes.stage}"`, 400);
      }
      if (
        changes.amount !== undefined &&
        !(Number.isFinite(changes.amount) && changes.amount >= 0)
      ) {
        throw new CrmError("amount must be a non-negative number", 400);
      }
      if (changes.ownerId !== undefined) requireUser(changes.ownerId);
      const changed = (Object.keys(changes) as (keyof DealChanges)[]).filter(
        (k) => changes[k] !== undefined && changes[k] !== deal[k],
      );
      const updated: Deal = { ...deal };
      for (const k of changed) Object.assign(updated, { [k]: changes[k] });
      state.deals.set(id, updated);
      if (changed.length > 0) {
        await report({ type: "deal.updated", payload: { deal: { ...updated }, changes: changed } });
      }
      return { deal: { ...updated }, changes: changed };
    },

    listUsers: () => [...state.users.values()].map((u) => ({ ...u })),
    getUser: (id) => {
      const u = state.users.get(id);
      return u && { ...u };
    },

    listOutbox: () => newestFirst(state.outbox).map((m) => ({ ...m })),
    sendEmail({ to, subject, body, idempotencyKey }) {
      const previous = state.outbox.find((m) => m.idempotencyKey === idempotencyKey);
      if (previous) return { message: { ...previous }, deduped: true };
      const message: OutboxMessage = {
        id: `m_${state.nextMessage++}`,
        to,
        subject,
        body,
        sentAt: iso(),
        idempotencyKey,
      };
      state.outbox.push(message);
      return { message: { ...message }, deduped: false };
    },

    listApprovals: () => newestFirst(state.approvals.values()).map(publicApproval),
    getApproval: (id) => {
      const a = state.approvals.get(id);
      return a && publicApproval(a);
    },
    upsertApproval({ id, runId, title, approverId, token }) {
      const existing = state.approvals.get(id);
      if (existing && existing.status !== "pending") return publicApproval(existing);
      const approval: StoredApproval = existing
        ? { ...existing, token }
        : {
            id,
            runId,
            title,
            approverId,
            token,
            status: "pending",
            createdAt: iso(),
            decidedAt: null,
          };
      // Re-insert so a refreshed approval sorts as the newest.
      state.approvals.delete(id);
      state.approvals.set(id, approval);
      return publicApproval(approval);
    },
    approvalToken(id) {
      const a = state.approvals.get(id);
      return a?.status === "pending" ? a.token : undefined;
    },
    settleApproval(id, status) {
      const a = state.approvals.get(id);
      if (!a) return undefined;
      if (a.status === "pending") {
        a.status = status;
        a.decidedAt = iso();
      }
      return publicApproval(a);
    },
    expireApproval(id) {
      const a = state.approvals.get(id);
      if (!a) return undefined;
      a.status = "expired";
      a.decidedAt = iso();
      return publicApproval(a);
    },
  };
  return store;
}
