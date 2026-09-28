/**
 * The engine's HTTP handler, `(Request) => Promise<Response>`, mounted under a base path (default
 * `/flowline`). Route shapes are documented in `@flowlinejs/core`'s `api-types` and consumed by
 * `@flowlinejs/core/client`.
 *
 * Editor routes are authenticated with `EngineOptions.authorize`; `POST /hooks/...` is
 * authenticated by the workflow's webhook slug (and optional HMAC signature), `POST /resume/:token`
 * by the callback token.
 *
 * @module
 */
import type {
  ApiErrorBody,
  RunStatus,
  RunWorkflowRequest,
  TestStepRequest,
  WorkflowDoc,
} from "@flowlinejs/core";
import type { Engine, EngineCore } from "./engine";
import {
  EngineConflictError,
  EngineNotFoundError,
  FlowlineValidationError,
  ResumeHostHandledError,
  ResumeUnverifiableError,
  WorkflowExistsError,
} from "./errors";
import { runEventStream } from "./sse";
import type { ListRunsFilter } from "./storage";
import type { Triggers } from "./triggers";
import { DEFAULT_BASE_PATH, isPlainObject } from "./util";
import { docShapeProblem } from "./workflows";

/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 1_048_576;
const MAX_LIST_LIMIT = 1_000;
const RUN_STATUSES: ReadonlySet<string> = new Set<RunStatus>([
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);

/** @internal What the handler serves. */
export interface HandlerDeps {
  core: EngineCore;
  engine: Omit<Engine, "handler">;
  triggers: Triggers;
}

/** Thrown inside a route to answer with an error status. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Partial<ApiErrorBody> = {},
  ) {
    super(message);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const notFound = (what = "Not found") => new HttpError(404, what);

/** The request body, at most {@link MAX_BODY_BYTES}. */
async function readBytes(req: Request): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError(413, "Request body too large");
  }
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, "Request body too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** The JSON request body; `undefined` when the body is empty. */
async function readJson(req: Request): Promise<unknown> {
  const text = new TextDecoder().decode(await readBytes(req));
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Body is not valid JSON");
  }
}

/** @internal Create the HTTP handler of an engine. */
export function createHandler({ core, engine, triggers }: HandlerDeps) {
  const { storage, registry } = core;
  const basePath = (core.opts.basePath ?? DEFAULT_BASE_PATH).replace(/\/+$/, "");
  let warnedOpen = false;

  const authorize = async (req: Request) => {
    if (!core.opts.authorize) {
      if (!warnedOpen) {
        warnedOpen = true;
        (core.logger ?? console).warn(
          'flowline: no authorize() configured; editor API requests run as tenant "default" without authentication',
        );
      }
      return { tenantId: "default", userId: "anonymous" };
    }
    const user = await core.opts.authorize(req);
    if (!user) throw new HttpError(401, "Unauthorized");
    return user;
  };

  const existingRun = async (tenantId: string, runId: string) => {
    const run = await storage.getRun(tenantId, runId);
    if (!run) throw notFound("Run not found");
    return run;
  };

  /** Public routes: authenticated by webhook slug or callback token. */
  const publicRoute = async (
    req: Request,
    method: string,
    seg: string[],
  ): Promise<Response | undefined> => {
    if (method !== "POST") return undefined;
    if (seg.length === 4 && seg[0] === "hooks") {
      const [, tenantId, workflowId, slug] = seg as [string, string, string, string];
      const result = await triggers.receiveWebhook({
        tenantId,
        workflowId,
        slug,
        headers: req.headers,
        body: await readBytes(req),
      });
      switch (result.status) {
        case "notFound":
          return json(404, { error: "Not found" });
        case "unauthorized":
          return json(401, { error: "Invalid signature" });
        case "invalid":
          return json(400, { error: result.message, issues: result.issues });
        case "skipped":
          return json(200, { skipped: true });
        case "started":
          return result.deduped
            ? json(200, { runId: result.runId, deduped: true })
            : json(202, { runId: result.runId });
      }
    }
    if (seg.length === 2 && seg[0] === "resume") {
      try {
        const outcome = await engine.resume(seg[1] as string, await readJson(req));
        return outcome === "resumed" ? json(202, {}) : json(410, { error: "gone" });
      } catch (err) {
        if (err instanceof ResumeUnverifiableError) {
          throw new HttpError(409, err.message, { code: err.code });
        }
        throw err;
      }
    }
    return undefined;
  };

  /** Editor routes, after authorization. */
  const editorRoute = async (
    req: Request,
    url: URL,
    method: string,
    seg: string[],
    user: { tenantId: string; userId: string },
  ): Promise<Response> => {
    const { tenantId, userId } = user;
    const [first, id, action] = seg;
    const n = seg.length;
    // Without a CORS preflight a cross-site request can only send a form or text content type, or
    // none (a no-cors fetch of a Blob). Requiring JSON on every mutation, bodyless ones too, keeps
    // cookie-authorized editor mutations out of reach of CSRF.
    const type = req.headers.get("content-type") ?? "";
    if (method !== "GET" && method !== "HEAD" && !/^application\/json\s*(;|$)/i.test(type)) {
      throw new HttpError(415, "Content-Type must be application/json");
    }

    if (method === "GET" && n === 1 && first === "manifest") {
      return json(200, registry.manifest());
    }
    if (method === "GET" && n === 1 && first === "secrets") {
      return json(200, (await core.opts.secrets?.list?.(tenantId)) ?? []);
    }
    if (method === "GET" && n === 1 && first === "subflows") {
      return json(200, await engine.listSubflows(tenantId));
    }

    if (first === "workflows") {
      if (method === "GET" && n === 1) return json(200, await storage.listWorkflows(tenantId));
      if (method === "POST" && n === 2 && id === "validate") {
        const doc = await readJson(req);
        const problem = docShapeProblem(doc);
        if (problem) throw new HttpError(400, problem);
        return json(200, await engine.validate(tenantId, doc as WorkflowDoc));
      }
      if (id === undefined) throw notFound();
      if (method === "GET" && n === 2) {
        const latest = await storage.getLatestVersion(tenantId, id);
        if (!latest) throw notFound("Workflow not found");
        return json(200, { latest, published: await storage.getPublishedVersion(tenantId, id) });
      }
      if (method === "PUT" && n === 2) {
        const doc = await readJson(req);
        const problem = docShapeProblem(doc);
        if (problem) throw new HttpError(400, problem);
        if ((doc as WorkflowDoc).id !== id) {
          throw new HttpError(400, "The workflow id in the body does not match the URL");
        }
        const create = url.searchParams.get("create");
        if (create !== null && create !== "true" && create !== "false") {
          throw new HttpError(400, "create must be true or false");
        }
        try {
          const opts = { create: create === "true" };
          return json(200, await engine.saveWorkflow(tenantId, doc as WorkflowDoc, userId, opts));
        } catch (err) {
          if (err instanceof WorkflowExistsError) {
            throw new HttpError(409, err.message, { code: err.code });
          }
          throw err;
        }
      }
      if (method === "POST" && n === 3 && action === "publish") {
        const body = await readJson(req);
        const version = isPlainObject(body) ? body.version : undefined;
        if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
          throw new HttpError(400, "Body must be { version: <positive integer> }");
        }
        if (!(await storage.getWorkflowVersion(tenantId, id, version))) {
          throw notFound("Workflow version not found");
        }
        try {
          await engine.publish(tenantId, id, version, userId);
        } catch (err) {
          if (err instanceof FlowlineValidationError) {
            throw new HttpError(422, err.message, { issues: err.issues });
          }
          // The version vanished between the check above and the publish.
          if (err instanceof EngineNotFoundError) throw notFound("Workflow version not found");
          throw err;
        }
        return json(200, { version });
      }
      if (method === "POST" && n === 3 && action === "run") {
        const body = await readJson(req);
        if (body !== undefined && !isPlainObject(body)) {
          throw new HttpError(400, "Body must be { input, dedupe }");
        }
        const dedupe = body?.dedupe;
        if (
          dedupe !== undefined &&
          (!isPlainObject(dedupe) ||
            (dedupe.key !== undefined && typeof dedupe.key !== "string") ||
            (dedupe.window !== undefined &&
              typeof dedupe.window !== "string" &&
              typeof dedupe.window !== "number"))
        ) {
          throw new HttpError(400, "dedupe must be { key?: string, window?: string | number }");
        }
        if (!(await storage.getPublishedVersion(tenantId, id))) {
          throw notFound("Workflow is not published");
        }
        // An invalid window is a FlowlineValidationError: 400.
        const runId = await engine.start({
          tenantId,
          workflowId: id,
          input: body?.input,
          dedupe: dedupe as RunWorkflowRequest["dedupe"],
          startedBy: { kind: "manual", userId },
        });
        return json(202, { runId });
      }
      if (method === "POST" && n === 3 && action === "test-step") {
        const body = await readJson(req);
        const step = isPlainObject(body) ? body.step : undefined;
        if (
          !isPlainObject(body) ||
          !isPlainObject(step) ||
          typeof step.id !== "string" ||
          typeof step.type !== "string" ||
          !isPlainObject(step.config) ||
          (body.samples !== undefined && !isPlainObject(body.samples))
        ) {
          throw new HttpError(400, "Body must be { step, doc, samples, triggerSample? }");
        }
        const request = { samples: {}, ...body } as unknown as TestStepRequest;
        return json(200, await engine.testStep(tenantId, request));
      }
      throw notFound();
    }

    if (first === "runs") {
      if (method === "GET" && n === 1) {
        const q = url.searchParams;
        const filter: ListRunsFilter = {};
        const workflowId = q.get("workflowId");
        if (workflowId) filter.workflowId = workflowId;
        const topLevel = q.get("topLevel");
        if (topLevel !== null) {
          if (topLevel !== "true" && topLevel !== "false") {
            throw new HttpError(400, "topLevel must be true or false");
          }
          if (topLevel === "true") filter.topLevel = true;
        }
        const stopped = q.get("stopped");
        if (stopped !== null) {
          if (stopped !== "true" && stopped !== "false") {
            throw new HttpError(400, "stopped must be true or false");
          }
          filter.stopped = stopped === "true";
        }
        const status = q.get("status");
        if (status) {
          if (!RUN_STATUSES.has(status)) throw new HttpError(400, `Unknown status "${status}"`);
          filter.status = status as RunStatus;
        }
        const limit = q.get("limit");
        if (limit !== null) {
          const value = Number(limit);
          if (!Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
            throw new HttpError(400, `limit must be an integer from 1 to ${MAX_LIST_LIMIT}`);
          }
          filter.limit = value;
        }
        return json(200, await storage.listRuns(tenantId, filter));
      }
      if (id === undefined) throw notFound();
      if (method === "GET" && n === 2) {
        const detail = await engine.getRunDetail(tenantId, id);
        if (!detail) throw notFound("Run not found");
        return json(200, detail);
      }
      if (method === "GET" && n === 3 && action === "stream") {
        await existingRun(tenantId, id);
        const raw = url.searchParams.get("after") ?? req.headers.get("last-event-id") ?? "0";
        const after = Number(raw);
        if (!Number.isInteger(after) || after < 0) {
          throw new HttpError(400, "after must be a non-negative integer");
        }
        return runEventStream({
          storage,
          subscribe: engine.subscribe,
          tenantId,
          runId: id,
          after,
          signal: req.signal,
          ...(core.logger ? { logger: core.logger } : {}),
        });
      }
      if (method === "POST" && n === 3 && action === "retry") {
        const run = await existingRun(tenantId, id);
        if (run.status !== "failed") throw new HttpError(409, `Run is ${run.status}, not failed`);
        try {
          return json(200, { runId: await engine.retryRun(tenantId, id) });
        } catch (err) {
          if (err instanceof EngineConflictError) throw new HttpError(409, err.message);
          if (err instanceof EngineNotFoundError) throw notFound();
          throw err;
        }
      }
      if (method === "POST" && n === 3 && action === "cancel") {
        await existingRun(tenantId, id);
        // Without authorize() nobody is signed in: record no actor, not the "anonymous" stand-in.
        const by = core.opts.authorize ? { by: userId } : {};
        const outcome = await engine.cancelRun(tenantId, id, by);
        if (outcome === "finished") return json(409, { error: "finished" });
        return json(outcome === "cancelled" ? 200 : 202, { status: outcome });
      }
      if (method === "POST" && n === 3 && action === "resume") {
        const step = url.searchParams.get("step");
        // Steps the host app resumes itself (`resume.hostHandled`) are refused here: 409.
        const opts = {
          refuseHostHandled: true,
          ...(step === null ? {} : { expectStep: step }),
        };
        try {
          const outcome = await engine.resumeRun(tenantId, id, await readJson(req), userId, opts);
          return outcome === "resumed" ? json(202, {}) : json(410, { error: "gone" });
        } catch (err) {
          if (err instanceof ResumeHostHandledError || err instanceof ResumeUnverifiableError) {
            throw new HttpError(409, err.message, { code: err.code });
          }
          throw err;
        }
      }
    }
    throw notFound();
  };

  return async function handler(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path !== basePath && !path.startsWith(`${basePath}/`)) throw notFound();
      let seg: string[];
      try {
        seg = path
          .slice(basePath.length)
          .replace(/^\/+|\/+$/g, "")
          .split("/")
          .filter((s) => s !== "")
          .map(decodeURIComponent);
      } catch {
        throw notFound();
      }
      const method = req.method.toUpperCase();
      const open = await publicRoute(req, method, seg);
      if (open) return open;
      const user = await authorize(req);
      return await editorRoute(req, url, method, seg, user);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message, ...err.extra });
      if (err instanceof FlowlineValidationError) {
        return json(400, { error: err.message, issues: err.issues });
      }
      (core.logger ?? console).error("flowline handler error", {
        error: err instanceof Error ? err.message : String(err),
      });
      return json(500, { error: "Internal error" });
    }
  };
}
