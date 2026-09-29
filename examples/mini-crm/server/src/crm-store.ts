/**
 * The mini CRM's data: an in-memory store of contacts, deals, users, logged calls, sent emails
 * (the outbox) and approval requests, seeded with demo data. It stands in for a real CRM's
 * database.
 *
 * The store knows nothing about Flowline. It reports changes (`contact.created`, `deal.updated`,
 * `ai_call.ended`, `voip_call.ended`) to the listener the app registers with {@link CrmStore.onEvent}, which turns them into
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
  stageEnteredAt: z.iso.datetime().describe("When the deal entered its current stage."),
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

/** How a call was made: by the AI agent, or over the phone system (VoIP). */
export type CallKind = "ai" | "voip";

/** A call with a contact that has ended. */
export interface Call {
  /** Call ID; the phone systems use it to deduplicate redeliveries. */
  id: string;
  /** The contact called. */
  contactId: string;
  /** Which system made the call. */
  kind: CallKind;
  /** Length in whole seconds. */
  durationSec: number;
  /** When it ended (ISO 8601). */
  endedAt: string;
  /** What was said, when the system provides a summary (the AI agent does). */
  summary?: string;
}

/** Fields accepted when logging a call. */
export interface NewCall {
  /** Call ID. Logging an existing ID redelivers that call's event. Default: a new ID. */
  id?: string;
  /** The contact called. */
  contactId: string;
  /** Which system made the call. */
  kind: CallKind;
  /** Length in whole seconds. */
  durationSec: number;
  /** What was said. */
  summary?: string;
}

/** Zod schema of an {@link OutboxMessage}. */
export const OutboxMessageSchema = z.object({
  id: z.string(),
  to: z.string(),
  subject: z.string(),
  body: z.string(),
  sentAt: z.iso.datetime(),
  idempotencyKey: z.string(),
  /** The run and workflow whose step sent it. Test steps' run IDs start with `test_`. */
  runId: z.string().optional(),
  workflowId: z.string().optional(),
});
/** An email the CRM "sent" (recorded, never delivered). */
export type OutboxMessage = z.infer<typeof OutboxMessageSchema>;

/**
 * State of an approval request. `expired` means its run stopped waiting undecided (it timed out
 * or was cancelled).
 */
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

/**
 * An approval request. It points at the waiting workflow step (`runId`, `stepPath`); deciding it
 * resumes that step through the engine's authorized `resumeRun`, so no callback token or resume
 * URL is ever stored here.
 */
export interface Approval {
  /** Approval ID, derived from `runId` and `stepPath`. */
  id: string;
  /** The run waiting for the decision. */
  runId: string;
  /** The waiting step's path in that run. */
  stepPath: string;
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

/**
 * A change the CRM reports to its listener. `id` is unique per event (use it to deduplicate).
 *
 * The two call events come from two different systems and have different shapes, as they would
 * in a real CRM: the AI agent reports `ai_call.ended` with seconds and a transcript summary, the
 * phone system reports `voip_call.ended` with milliseconds.
 */
export type CrmEvent =
  | { id: string; type: "contact.created"; payload: { contact: Contact } }
  | { id: string; type: "deal.updated"; payload: { deal: Deal; changes: string[] } }
  | {
      id: string;
      type: "ai_call.ended";
      payload: {
        call: {
          id: string;
          contactId: string;
          seconds: number;
          endedAt: string;
          transcriptSummary: string;
        };
      };
    }
  | {
      id: string;
      type: "voip_call.ended";
      payload: { callId: string; contactId: string; durationMs: number; endedAt: string };
    };

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

interface State {
  contacts: Map<string, Contact>;
  deals: Map<string, Deal>;
  users: Map<string, User>;
  calls: Map<string, Call>;
  outbox: OutboxMessage[];
  approvals: Map<string, Approval>;
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

const SEED_DEALS: Omit<Deal, "stageEnteredAt">[] = [
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
  /**
   * Restore the seed data: contacts, deals and users as seeded (deals entering their stage now),
   * no calls, empty outbox and approvals.
   */
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
  /**
   * Change a contact.
   * @throws {@link CrmError} 404 for an unknown contact, 400 for an unknown owner, 409 when the
   * new email belongs to another contact.
   */
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

  /**
   * Log a call that ended and report `ai_call.ended` or `voip_call.ended`. Logging an `id` that
   * exists already returns that call unchanged and reports its event again, the way a phone
   * system redelivers a webhook.
   * @throws {@link CrmError} 404 for an unknown contact, 400 for an invalid duration.
   */
  logCall(input: NewCall): Promise<Call>;
  /** Logged calls, oldest first; only the calls with `contactId` when it is given. */
  listCalls(contactId?: string): Call[];

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
  sendEmail(msg: {
    to: string;
    subject: string;
    body: string;
    idempotencyKey: string;
    runId?: string;
    workflowId?: string;
  }): {
    message: OutboxMessage;
    deduped: boolean;
  };

  /** Approval requests, newest first. */
  listApprovals(): Approval[];
  /** The approval with this ID, if any. */
  getApproval(id: string): Approval | undefined;
  /**
   * Record a pending approval. Recording one that exists already (a re-run step, or rebuilding
   * approvals after a restart) keeps the existing record.
   */
  upsertApproval(a: {
    id: string;
    runId: string;
    stepPath: string;
    title: string;
    approverId: string;
    /** Request time (ISO 8601). Default: now. */
    createdAt?: string;
  }): Approval;
  /**
   * Move a pending approval to `status`. Returns the updated approval, or `undefined` when it is
   * unknown or no longer pending (the first outcome wins).
   */
  settleApproval(id: string, status: Exclude<ApprovalStatus, "pending">): Approval | undefined;
  /** Make an approval pending again, e.g. when resuming its run failed after it was claimed. */
  reopenApproval(id: string): Approval | undefined;
  /** Mark an approval expired, whatever its state: its run no longer waits for a decision. */
  expireApproval(id: string): Approval | undefined;
}

/**
 * Create a CRM store seeded with 12 contacts, 8 deals (each entering its stage when seeded) and 5
 * users.
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
      deals: new Map(SEED_DEALS.map((d) => [d.id, { ...d, stageEnteredAt: at }])),
      users: new Map(SEED_USERS.map((u) => [u.id, { ...u }])),
      calls: new Map(),
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
  /** A user referenced by a create or update: unknown is invalid input (400), not a 404. */
  const requireOwner = (id: string): void => {
    if (!state.users.has(id)) throw new CrmError(`Unknown owner "${id}"`, 400);
  };
  /** Throws a 409 when another contact than `exceptId` has `email`. */
  const requireFreeEmail = (email: string, exceptId?: string): void => {
    const wanted = email.trim().toLowerCase();
    const taken = [...state.contacts.values()].some(
      (c) => c.id !== exceptId && c.email.toLowerCase() === wanted,
    );
    if (taken) throw new CrmError(`A contact with email "${email.trim()}" already exists`, 409);
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
      requireFreeEmail(email);
      if (fields.ownerId) requireOwner(fields.ownerId);
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
      if (changes.ownerId) requireOwner(changes.ownerId);
      const email = changes.email?.trim();
      if (email !== undefined) {
        if (email === "") throw new CrmError("A contact needs an email", 400);
        requireFreeEmail(email, id);
      }
      const updated = {
        ...contact,
        ...changes,
        ...(email !== undefined ? { email } : {}),
        id,
        createdAt: contact.createdAt,
      };
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
      if (changes.ownerId !== undefined) requireOwner(changes.ownerId);
      const changed = (Object.keys(changes) as (keyof DealChanges)[]).filter(
        (k) => changes[k] !== undefined && changes[k] !== deal[k],
      );
      const updated: Deal = { ...deal };
      for (const k of changed) Object.assign(updated, { [k]: changes[k] });
      if (changed.includes("stage")) updated.stageEnteredAt = iso();
      state.deals.set(id, updated);
      if (changed.length > 0) {
        await report({ type: "deal.updated", payload: { deal: { ...updated }, changes: changed } });
      }
      return { deal: { ...updated }, changes: changed };
    },

    async logCall({ id, contactId, kind, durationSec, summary }) {
      const existing = id === undefined ? undefined : state.calls.get(id);
      if (!existing) {
        requireContact(contactId);
        if (!(Number.isInteger(durationSec) && durationSec >= 0)) {
          throw new CrmError("durationSec must be a whole number of seconds", 400);
        }
      }
      const call: Call = existing ?? {
        id: id ?? `call_${globalThis.crypto.randomUUID().slice(0, 8)}`,
        contactId,
        kind,
        durationSec,
        endedAt: iso(),
        ...(summary !== undefined ? { summary } : {}),
      };
      state.calls.set(call.id, call);
      await report(
        call.kind === "ai"
          ? {
              type: "ai_call.ended",
              payload: {
                call: {
                  id: call.id,
                  contactId: call.contactId,
                  seconds: call.durationSec,
                  endedAt: call.endedAt,
                  transcriptSummary: call.summary ?? "",
                },
              },
            }
          : {
              type: "voip_call.ended",
              payload: {
                callId: call.id,
                contactId: call.contactId,
                durationMs: call.durationSec * 1000,
                endedAt: call.endedAt,
              },
            },
      );
      return { ...call };
    },
    listCalls: (contactId) =>
      [...state.calls.values()]
        .filter((c) => contactId === undefined || c.contactId === contactId)
        .map((c) => ({ ...c })),

    listUsers: () => [...state.users.values()].map((u) => ({ ...u })),
    getUser: (id) => {
      const u = state.users.get(id);
      return u && { ...u };
    },

    listOutbox: () => newestFirst(state.outbox).map((m) => ({ ...m })),
    sendEmail({ to, subject, body, idempotencyKey, runId, workflowId }) {
      const previous = state.outbox.find((m) => m.idempotencyKey === idempotencyKey);
      if (previous) return { message: { ...previous }, deduped: true };
      const message: OutboxMessage = {
        id: `m_${state.nextMessage++}`,
        to,
        subject,
        body,
        sentAt: iso(),
        idempotencyKey,
        ...(runId ? { runId } : {}),
        ...(workflowId ? { workflowId } : {}),
      };
      state.outbox.push(message);
      return { message: { ...message }, deduped: false };
    },

    listApprovals: () =>
      [...state.approvals.values()]
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .map((a) => ({ ...a })),
    getApproval: (id) => {
      const a = state.approvals.get(id);
      return a && { ...a };
    },
    upsertApproval({ id, runId, stepPath, title, approverId, createdAt }) {
      const existing = state.approvals.get(id);
      if (existing) return { ...existing };
      const approval: Approval = {
        id,
        runId,
        stepPath,
        title,
        approverId,
        status: "pending",
        createdAt: createdAt ?? iso(),
        decidedAt: null,
      };
      state.approvals.set(id, approval);
      return { ...approval };
    },
    settleApproval(id, status) {
      const a = state.approvals.get(id);
      if (a?.status !== "pending") return undefined;
      a.status = status;
      a.decidedAt = iso();
      return { ...a };
    },
    reopenApproval(id) {
      const a = state.approvals.get(id);
      if (!a) return undefined;
      a.status = "pending";
      a.decidedAt = null;
      return { ...a };
    },
    expireApproval(id) {
      const a = state.approvals.get(id);
      if (!a) return undefined;
      a.status = "expired";
      a.decidedAt = iso();
      return { ...a };
    },
  };
  return store;
}
