/**
 * The mini CRM server: a Hono app serving the CRM's REST API under `/api` and the Flowline engine
 * (editor API, webhooks, callbacks) under `/flowline`.
 *
 * @module
 */
import { createRegistry, type Logger } from "@flowline/core";
import {
  createEngine,
  type Engine,
  FlowlineValidationError,
  type StorageAdapter,
} from "@flowline/engine";
import { createMemoryStorage } from "@flowline/storage-memory";
import { Hono } from "hono";
import { z } from "zod";
import { CrmError, type CrmStore, createCrmStore, DEAL_STAGES } from "./crm-store";
import { seedFlows } from "./flows";
import { crmPlugin, restoreApprovals } from "./plugin";

/** The demo's only tenant. */
export const TENANT_ID = "acme";
/**
 * The user every request acts as. The demo has NO authentication: see {@link demoAuthorize}.
 */
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
  /** The Flowline engine. Run a worker (`engine.startWorker()`) or `engine.drain()` it. */
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

/**
 * Who is calling. The demo has no login, so every request, to `/api` and to `/flowline` alike, is
 * user `demo-user` of tenant `acme`.
 *
 * A production host must instead authenticate the request with its own session (cookie, bearer
 * token, ...) and derive both IDs from it, returning `null` when there is no valid session so the
 * engine answers 401:
 *
 * ```ts
 * async function authorize(req: Request) {
 *   const session = await sessions.fromRequest(req); // your auth
 *   if (!session) return null;
 *   return { tenantId: session.accountId, userId: session.userId };
 * }
 * ```
 *
 * Run the same check as middleware in front of `/api/*`, scope every CRM query to the session's
 * tenant, and check permissions per route (e.g. only `approval.approverId` may decide it).
 */
async function demoAuthorize(_req: Request): Promise<{ tenantId: string; userId: string } | null> {
  return { tenantId: TENANT_ID, userId: DEMO_USER_ID };
}

/** Statuses of runs that have not finished. */
const ACTIVE_STATUSES = ["queued", "running", "waiting"] as const;
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

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
    authorize: demoAuthorize,
  });

  // CRM changes start workflows, with the event's ID as the dedupe key. Here a failed emit is only
  // logged and the event is lost (a workflow problem must not fail the CRM change). A production
  // host would write each event to a transactional outbox with the change and redeliver it with
  // the same stored ID until the emit succeeds; the dedupe key makes redelivery start one run.
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
  // The CRM is in memory but the engine may persist: re-create approvals of runs still waiting.
  await restoreApprovals(engine, crm, TENANT_ID);

  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof CrmError) return c.json({ error: err.message }, err.status);
    if (err instanceof FlowlineValidationError) {
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
  /** Whether run `runId` still waits on a callback at step `stepPath`. */
  const waitsAt = async (runId: string, stepPath: string): Promise<boolean> => {
    const run = await engine.storage.getRun(TENANT_ID, runId);
    return (
      run?.status === "waiting" && run.waitReason === "callback" && run.currentStep === stepPath
    );
  };

  app.get("/api/approvals", async (c) => {
    // A run cancelled elsewhere (e.g. from the run viewer) leaves its approval pending: expire
    // those lazily here. One lookup per pending approval; a real inbox would page.
    for (const a of crm.listApprovals()) {
      if (a.status !== "pending") continue;
      const run = await engine.storage.getRun(TENANT_ID, a.runId);
      if (!run || TERMINAL_STATUSES.has(run.status)) crm.expireApproval(a.id);
    }
    return c.json(crm.listApprovals());
  });

  app.post("/api/approvals/:id/decision", async (c) => {
    const id = c.req.param("id");
    const { decision } = await readBody(c.req.raw, DecisionBody);
    const current = crm.getApproval(id);
    if (!current) throw new CrmError(`Approval "${id}" not found`, 404);
    // Claim it synchronously before the first await, so a concurrent second decision gets a 409.
    const decided = crm.settleApproval(id, decision);
    if (!decided) {
      return c.json({ error: `Approval is already ${current.status}`, approval: current }, 409);
    }
    try {
      // `expectStep` makes the step check and the resume one compare-and-set: only the callback
      // wait of this approval's step is resumed, never a later wait of the same run.
      const outcome = await engine.resumeRun(TENANT_ID, decided.runId, { decision }, DEMO_USER_ID, {
        expectStep: decided.stepPath,
      });
      if (outcome === "gone") {
        // The run stopped waiting (timed out or was cancelled) before this decision.
        return c.json({ error: "gone", approval: crm.expireApproval(id) }, 410);
      }
      return c.json({ approval: decided }, 202);
    } catch (err) {
      // The run was not resumed. If it still waits at the step, undo the claim so the decision
      // can be retried; if it stopped waiting meanwhile (timed out, cancelled), nobody can decide
      // any more. When even that lookup fails, reopen: a later decision gets 410 and expires it.
      const retryable = await waitsAt(decided.runId, decided.stepPath).catch(() => true);
      if (retryable) crm.reopenApproval(id);
      else crm.expireApproval(id);
      throw err;
    }
  });

  app.get("/api/demo", async (c) => {
    const webhooks: Record<string, string> = {};
    for (const v of await engine.storage.listPublished({ tenantId: TENANT_ID })) {
      const slug = v.doc.trigger.config.slug;
      if (v.doc.trigger.type === "core.webhook" && typeof slug === "string") {
        webhooks[v.workflowId] = `/flowline/hooks/${TENANT_ID}/${v.workflowId}/${slug}`;
      }
    }
    return c.json({ tenantId: TENANT_ID, userId: DEMO_USER_ID, webhooks });
  });
  app.post("/api/demo/reset", async (c) => {
    // Cancel unfinished runs first: they reference contacts and approvals that are about to go.
    for (const status of ACTIVE_STATUSES) {
      for (const run of await engine.storage.listRuns(TENANT_ID, { status, limit: 1000 })) {
        await engine.cancelRun(TENANT_ID, run.id, { by: DEMO_USER_ID, reason: "Demo data reset" });
      }
    }
    crm.reset();
    return c.body(null, 204);
  });

  app.all("/flowline/*", (c) => engine.handler(c.req.raw));

  return { app, engine, crm };
}
