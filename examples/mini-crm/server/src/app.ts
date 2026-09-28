/**
 * The mini CRM server: a Hono app serving the CRM's REST API under `/api` and the Flowkit engine
 * (editor API, webhooks, callbacks) under `/flowkit`.
 *
 * @module
 */
import { createRegistry, type Logger } from "@flowkit/core";
import {
  createEngine,
  type Engine,
  FlowkitValidationError,
  type StorageAdapter,
} from "@flowkit/engine";
import { createMemoryStorage } from "@flowkit/storage-memory";
import { Hono } from "hono";
import { z } from "zod";
import { CrmError, type CrmStore, createCrmStore, DEAL_STAGES } from "./crm-store";
import { seedFlows } from "./flows";
import { crmPlugin } from "./plugin";

/** The demo's only tenant. */
export const TENANT_ID = "acme";
/** The user every request acts as (the demo has no login). */
export const DEMO_USER_ID = "demo-user";

/** Options of {@link createMiniCrm}. */
export interface MiniCrmOptions {
  /** Engine storage. Default: in memory. */
  storage?: StorageAdapter;
  /** Time source in epoch ms, shared by the engine and the CRM. Default `Date.now`. */
  clock?: () => number;
  /** Public origin of the server, used in callback URLs. */
  publicUrl?: string;
  /** Engine and server logger. */
  logger?: Logger;
}

/** A wired-up mini CRM. */
export interface MiniCrm {
  /** The HTTP app; serve it with `@hono/node-server` or call `app.request()` in tests. */
  app: Hono;
  /** The Flowkit engine. Run a worker (`engine.startWorker()`) or `engine.drain()` it. */
  engine: Engine;
  /** The CRM store. */
  crm: CrmStore;
}

const NewContactBody = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.email(),
  company: z.string().optional(),
  source: z.string().optional(),
  ownerId: z.string().nullable().optional(),
});

const DealPatchBody = z
  .object({
    name: z.string().min(1),
    stage: z.enum(DEAL_STAGES),
    amount: z.number().nonnegative(),
    ownerId: z.string().min(1),
  })
  .partial()
  .strict();

const DecisionBody = z.object({ decision: z.enum(["approved", "rejected"]) });

const consoleLogger: Logger = {
  debug: () => {},
  info: (m, d) => console.info(m, d ?? ""),
  warn: (m, d) => console.warn(m, d ?? ""),
  error: (m, d) => console.error(m, d ?? ""),
};

/** Parse a JSON request body with `schema`; a 400 `{ error, issues }` response when invalid. */
async function readBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new CrmError("Body must be JSON", 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new CrmError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      400,
    );
  }
  return parsed.data;
}

/**
 * Create the mini CRM: the CRM store, an engine with the `crm` plugin, the demo workflows
 * (saved and published for tenant `acme`) and the HTTP app.
 */
export async function createMiniCrm(opts: MiniCrmOptions = {}): Promise<MiniCrm> {
  const clock = opts.clock ?? Date.now;
  const logger = opts.logger ?? consoleLogger;
  const crm = createCrmStore({ clock });
  const engine = createEngine({
    registry: createRegistry([crmPlugin]),
    storage: opts.storage ?? createMemoryStorage(),
    services: { crm },
    clock,
    logger,
    ...(opts.publicUrl ? { publicUrl: opts.publicUrl } : {}),
    // The demo has no login: everyone is the same user of tenant "acme".
    authorize: async () => ({ tenantId: TENANT_ID, userId: DEMO_USER_ID }),
  });

  // CRM changes start workflows. The event ID is the dedupe key, so re-delivering an event never
  // starts a second run. A workflow problem must not fail the CRM change itself: log it.
  crm.onEvent(async (event) => {
    try {
      await engine.emit(event.type, event.payload, { tenantId: TENANT_ID, dedupeKey: event.id });
    } catch (err) {
      logger.error("could not start workflows for CRM event", {
        event: event.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  await seedFlows(engine, TENANT_ID);

  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof CrmError) return c.json({ error: err.message }, err.status);
    if (err instanceof FlowkitValidationError) {
      return c.json({ error: err.message, issues: err.issues }, 400);
    }
    logger.error("request failed", { path: c.req.path, error: String(err) });
    return c.json({ error: "Internal error" }, 500);
  });

  app.get("/api/contacts", (c) => c.json(crm.listContacts()));
  app.post("/api/contacts", async (c) => {
    const body = await readBody(c.req.raw, NewContactBody);
    return c.json(await crm.createContact(body), 201);
  });

  app.get("/api/deals", (c) => c.json(crm.listDeals()));
  app.patch("/api/deals/:id", async (c) => {
    const body = await readBody(c.req.raw, DealPatchBody);
    return c.json(await crm.updateDeal(c.req.param("id"), body));
  });

  app.get("/api/users", (c) => c.json(crm.listUsers()));
  app.get("/api/outbox", (c) => c.json(crm.listOutbox()));
  app.get("/api/approvals", (c) => c.json(crm.listApprovals()));

  app.post("/api/approvals/:id/decision", async (c) => {
    const id = c.req.param("id");
    const { decision } = await readBody(c.req.raw, DecisionBody);
    const approval = crm.getApproval(id);
    if (!approval) throw new CrmError(`Approval "${id}" not found`, 404);
    const token = crm.approvalToken(id);
    if (!token) return c.json({ error: `Approval is already ${approval.status}` }, 409);
    // Record the decision before resuming, so a concurrent second decision gets a 409.
    const decided = crm.settleApproval(id, decision);
    // Resume server-side with the stored token: it never leaves the server.
    const outcome = await engine.resume(token, { decision, by: DEMO_USER_ID });
    if (outcome === "gone") {
      // The run stopped waiting (timed out or was cancelled) before this decision.
      return c.json({ error: "gone", approval: crm.expireApproval(id) }, 410);
    }
    return c.json({ approval: decided }, 202);
  });

  app.get("/api/demo", async (c) => {
    const webhooks: Record<string, string> = {};
    for (const v of await engine.storage.listPublished({ tenantId: TENANT_ID })) {
      const slug = v.doc.trigger.config.slug;
      if (v.doc.trigger.type === "core.webhook" && typeof slug === "string") {
        webhooks[v.workflowId] = `/flowkit/hooks/${TENANT_ID}/${v.workflowId}/${slug}`;
      }
    }
    return c.json({ tenantId: TENANT_ID, userId: DEMO_USER_ID, webhooks });
  });
  app.post("/api/demo/reset", (c) => {
    crm.reset();
    return c.body(null, 204);
  });

  app.all("/flowkit/*", (c) => engine.handler(c.req.raw));

  return { app, engine, crm };
}
