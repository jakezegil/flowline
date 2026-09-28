/**
 * `createEngine`: the durable workflow engine over a {@link StorageAdapter}.
 *
 * @module
 */
import {
  createRegistry,
  type FlowkitServices,
  findStep,
  type Issue,
  type Logger,
  type Registry,
  type RunDetail,
  type RunEvent,
  type RunEventType,
  type RunOrigin,
  type SubflowInfo,
  type TestStepRequest,
  type TestStepResponse,
  type TransformRuntime,
  type WorkflowDoc,
  type WorkflowVersion,
} from "@flowkit/core";
import { builtinPlugin } from "@flowkit/nodes-builtin";
import {
  EngineConflictError,
  EngineNotFoundError,
  FlowkitValidationError,
  ResumeHostHandledError,
} from "./errors";
import { cancelPatch, createExecutor, TERMINAL } from "./executor";
import { createHandler } from "./handler";
import { entryAt } from "./interpreter";
import { createRunBus } from "./sse";
import type { NewRunEvent, Run, RunPatch, StorageAdapter } from "./storage";
import { createTriggers } from "./triggers";
import { startWorker, type Worker, type WorkerOptions } from "./worker";
import { createWorkflows } from "./workflows";

/** Options of {@link createEngine}. */
export interface EngineOptions {
  /**
   * Plugins, nodes and triggers the engine can run. The built-in `core` plugin is added unless
   * `builtins` is `false` or the registry already has a plugin with ID `"core"`.
   */
  registry: Registry;
  /** Where workflows, runs and events are persisted. */
  storage: StorageAdapter;
  /** Host services exposed to handlers as `ctx.services`. */
  services?: FlowkitServices;
  /** Host secret store; handlers read secrets with `ctx.secrets.get(name)`. */
  secrets?: {
    /** The secret's value for the tenant, or `undefined` if it is not configured. */
    get(tenantId: string, name: string): Promise<string | undefined>;
    /** Names of the tenant's secrets (never values), for the editor. */
    list?(tenantId: string): Promise<string[]>;
  };
  /** Authenticates editor API requests; `null` rejects the request. */
  authorize?: (req: Request) => Promise<{ tenantId: string; userId: string } | null>;
  /** Final scrubbing of every event before it is stored or emitted. */
  redact?: (e: NewRunEvent) => NewRunEvent;
  /** Sandboxed JavaScript runtime exposed to handlers as `ctx.transform`. */
  transform?: TransformRuntime;
  /** Called with every event after it was persisted. Errors thrown here are logged and ignored. */
  onEvent?: (e: NewRunEvent) => void;
  /** Time source in epoch ms. Default `Date.now`. */
  clock?: () => number;
  /** Public origin used to build callback URLs, e.g. `"https://app.example.com"`. */
  publicUrl?: string;
  /** Path the HTTP handler is mounted under. Default `"/flowkit"`. */
  basePath?: string;
  /** Lease duration in ms; the lease is renewed every `leaseMs / 2` while a handler runs. Default `30_000`. */
  leaseMs?: number;
  /** Steps executed per claim before the run is re-queued for fairness. Default `100`. */
  stepsPerClaim?: number;
  /**
   * Network policy of `ctx.http.fetch`: non-public addresses are blocked unless
   * `allowPrivateNetworks`; `allowHosts` (exact, case-insensitive hostnames) restricts the hosts
   * that may be requested; response bodies over `maxResponseBytes` (default 10 MB) fail.
   */
  http?: { allowPrivateNetworks?: boolean; allowHosts?: string[]; maxResponseBytes?: number };
  /** Engine and handler logger. */
  logger?: Logger;
  /**
   * Register the built-in `core.*` nodes and triggers (`@flowkit/nodes-builtin`) ahead of the
   * registry's own plugins. Default `true`.
   */
  builtins?: boolean;
  /**
   * @internal Test-only hooks (crash injection). Not part of the public API; may change at any
   * time.
   */
  __testHooks?: {
    /**
     * Called before every run commit; throwing simulates a crash before the write. `phase` is
     * `"start"` for the commit that marks a step in flight (before its handler runs) and
     * `"result"` for every other commit. `stepPath` is `""` for run-level commits.
     */
    beforeCommit?(runId: string, stepPath: string, phase: "start" | "result"): void | Promise<void>;
  };
}

/** Options of {@link Engine.resumeRun}. */
export interface ResumeRunOptions {
  /** Resume only when the run waits on a callback at this step path (e.g. `"size/if/approval"`). */
  expectStep?: string;
  /**
   * Refuse (throw {@link ResumeHostHandledError}) when the waiting step's node declares
   * `resume.hostHandled`. The generic `POST /runs/:id/resume` route sets it; host code that
   * resumes such a step itself (e.g. an approvals endpoint) leaves it unset.
   */
  refuseHostHandled?: boolean;
}

/** A running engine instance. */
export interface Engine {
  /**
   * The registry the engine executes against: the host registry, with the built-in `core` plugin
   * in front unless disabled. Serve its manifest to the editor.
   */
  registry: Registry;
  /** The engine's storage adapter. */
  storage: StorageAdapter;
  /**
   * Claim one runnable run and advance it until it completes, fails, waits or uses up its step
   * budget. Resolves `true` if a run was claimed, `false` if none was runnable.
   *
   * @param workerId Lease owner recorded on the run and on its events. Defaults to an ID unique to
   * this engine instance.
   */
  runOnce(workerId?: string): Promise<boolean>;
  /**
   * Call {@link Engine.runOnce} until no run is runnable (or `maxClaims`, default `10_000`, is
   * reached). Resolves the number of claims made. Waiting runs whose `wakeAt` lies in the future
   * are not advanced.
   */
  drain(opts?: { maxClaims?: number }): Promise<number>;
  /**
   * Resume the run waiting on callback `token` (from `ctx.callback()`) with `body` as
   * `ctx.resume = { kind: "callback", body }`. Tokens are single use: resolves `"gone"` when the
   * token is unknown, already used, expired, or its run is no longer waiting.
   *
   * @throws {FlowkitValidationError} (rejects, resuming nothing) when the waiting step's node
   * declares `resume.body` and `body` doesn't match it.
   */
  resume(token: string, body: unknown): Promise<"resumed" | "gone">;
  /**
   * Resume a callback-waiting run without its token, for authorized callers such as the run
   * viewer. Behaves like {@link Engine.resume} and records `userId` on the `run.resumed` event.
   * Resolves `"gone"` when the run does not exist in the tenant or is not waiting on a callback.
   *
   * With `opts.expectStep`, it resumes only a callback wait of the step at that path, and resolves
   * `"gone"` otherwise. The check and the resume are one compare-and-set: the run is resumed by
   * the token of the wait that was checked, so a wait that ended meanwhile (even one replaced by a
   * new wait at the same step) is not resumed. Use it when the caller decided about one specific
   * step, e.g. an approval inbox.
   *
   * @throws {FlowkitValidationError} when the waiting step's node declares `resume.body` and
   * `body` doesn't match it.
   * @throws {ResumeHostHandledError} with `opts.refuseHostHandled`, when the waiting step's node
   * declares `resume.hostHandled`.
   */
  resumeRun(
    tenantId: string,
    runId: string,
    body: unknown,
    userId: string,
    opts?: ResumeRunOptions,
  ): Promise<"resumed" | "gone">;
  /**
   * Cancel a run. A queued or waiting run (or a running one whose worker's lease has expired) is
   * cancelled at once: resolves `"cancelled"`. A run a worker is executing right now is flagged
   * instead (`Run.cancelRequestedAt`): resolves `"requested"`, and that worker aborts `ctx.signal`
   * and cancels the run under its lease at its next check (right after claiming, before each
   * step, before it would wait or be re-queued, and on every lease renewal while a handler runs).
   * Resolves `"finished"` when the run had already completed, failed or been cancelled.
   *
   * A run whose last step finishes before the worker's next check still completes (or fails).
   * A run is never left parked (`waiting`/`queued`) with a pending request: the worker re-reads
   * the run after each commit that parks it and cancels it if flagged, and `cancelRun` re-reads
   * the run after flagging it and cancels it directly if it is no longer leased.
   *
   * A cancelled sub-flow resumes its parent step with `subflowFailed` ("Sub-flow cancelled").
   * Cancelling a parent does NOT cancel its child runs: they run to completion, and their
   * wake-up of the cancelled parent is ignored.
   *
   * @throws Error if the run does not exist in the tenant.
   */
  cancelRun(tenantId: string, runId: string): Promise<"cancelled" | "requested" | "finished">;
  /**
   * Continue a failed run from its failed step: the failed journal entry is removed and the run
   * is queued again (same run id, attempt 1); steps that completed are not re-run. Resolves the
   * run id.
   *
   * A failed sub-flow run can be retried only while its parent step still waits on it. A child
   * that fails wakes its parent (with `subflowFailed`) in the same write, so normally the parent
   * has moved on: retry the parent instead, whose step then starts a new child run.
   *
   * @throws Error if the run does not exist, is not failed, or is a sub-flow run whose parent no
   * longer waits on it.
   */
  retryRun(tenantId: string, runId: string): Promise<string>;

  /**
   * The HTTP API (see `@flowkit/core`'s `api-types` for the routes) under `basePath`. Mount it on
   * any `fetch`-style server, e.g. `app.all("/flowkit/*", (c) => engine.handler(c.req.raw))`.
   * Editor routes require `authorize` (without it every request acts as tenant `"default"`, with a
   * logged warning); webhooks and callback resumes are authenticated by slug/signature and token.
   */
  handler(req: Request): Promise<Response>;
  /**
   * Poll for runnable runs in the background: `concurrency` independent loops call
   * {@link Engine.runOnce}, sleeping `pollMs` (with jitter) when idle; the first loop also calls
   * {@link Engine.tickSchedules} every `scheduleEveryMs`. `stop()` awaits in-flight work.
   */
  startWorker(opts?: WorkerOptions): Worker;
  /**
   * Start a run of every published workflow of the tenant whose `event` trigger listens to `event`
   * (a plugin trigger's `event`, or `config.event` of `core.event`) and whose `filter` accepts the
   * payload. The payload is validated against each trigger's payload schema first: if it is
   * invalid for any of them, a {@link FlowkitValidationError} is thrown and no run is created.
   * With a dedupe key (`opts.dedupeKey`, else the trigger's `dedupeKey()`), at most one run per
   * workflow and key is ever started. Resolves the IDs of the runs this call started.
   */
  emit(
    event: string,
    payload: unknown,
    opts: { tenantId: string; dedupeKey?: string },
  ): Promise<string[]>;
  /**
   * Start a run of the workflow's published version with `input` (default `{}`) as the trigger
   * payload, validated against the trigger's declared fields or payload schema (a
   * {@link FlowkitValidationError} when invalid). `startedBy` defaults to `{ kind: "manual" }`. With
   * `dedupeKey`, repeated calls start one run and all resolve its ID.
   *
   * @throws Error if the workflow has no published version in the tenant.
   */
  start(opts: {
    tenantId: string;
    workflowId: string;
    input?: unknown;
    dedupeKey?: string;
    startedBy?: RunOrigin;
  }): Promise<string>;
  /**
   * Start the due run of every published schedule workflow (all tenants): the latest cron fire
   * time at or before now, in the trigger's time zone, unless it is before the workflow was
   * published. Each fire time starts at most one run, even with many engines ticking concurrently.
   * No catch-up: after downtime only the latest missed fire runs. Resolves the number of runs
   * started.
   */
  tickSchedules(): Promise<number>;
  /**
   * Save `doc` as the workflow's next version and audit it (`saved`). A webhook-triggered doc
   * without a slug (`trigger.config.slug`) keeps the previous version's slug, or gets a new random
   * one: its URL is `<basePath>/hooks/<tenantId>/<workflowId>/<slug>`.
   *
   * @throws {@link FlowkitValidationError} if `doc` is not a structurally valid document.
   */
  saveWorkflow(tenantId: string, doc: WorkflowDoc, actor: string): Promise<WorkflowVersion>;
  /**
   * Publish a saved version (after validating it) and audit it (`published`).
   *
   * @throws {@link FlowkitValidationError} with the issues if the version has errors.
   * @throws Error if the version does not exist.
   */
  publish(tenantId: string, workflowId: string, version: number, actor: string): Promise<void>;
  /** Validate `doc` against the registry and the tenant's published sub-flows. */
  validate(tenantId: string, doc: WorkflowDoc): Promise<Issue[]>;
  /** The tenant's published workflows callable as sub-flows, by ID. */
  listSubflows(tenantId: string): Promise<SubflowInfo[]>;
  /**
   * A run with its events and pinned doc, as shown in the run viewer: without lease or callback
   * state, and with `sensitive` step input/output values masked. `null` if not found.
   */
  getRunDetail(tenantId: string, runId: string): Promise<RunDetail | null>;
  /**
   * Run one step against sample data, without creating a run or journaling anything: config is
   * resolved against `samples` (by step ID) and `triggerSample`, and control-flow signals
   * (suspend, including callbacks, stop, sub-flow) are reported instead of executed.
   *
   * `secret` input and output fields are masked, as in the journal. `sensitive` fields are shown:
   * the response goes only to an editor of the tenant and is not stored.
   */
  testStep(tenantId: string, req: TestStepRequest): Promise<TestStepResponse>;
  /**
   * Listen to a run's events as this engine commits them (other processes' commits are not
   * seen; the HTTP stream also polls storage for those). Events arrive in `seq` order, each once;
   * the first commit after subscribing also delivers the run's earlier events. Returns the
   * unsubscribe function.
   */
  subscribe(runId: string, fn: (e: RunEvent) => void): () => void;
}

/** @internal What the engine's modules (triggers, workflows, handler) share. */
export interface EngineCore {
  /** Engine options, with the effective registry. */
  opts: EngineOptions;
  registry: Registry;
  storage: StorageAdapter;
  clock: () => number;
  logger?: Logger;
  /** A run event (redacted with `opts.redact`). */
  event(
    run: Pick<Run, "id" | "tenantId">,
    type: RunEventType,
    stepPath: string | undefined,
    data?: unknown,
  ): NewRunEvent;
  /** Report persisted events to `onEvent` and the run bus. */
  publish(events: NewRunEvent[]): void;
}

/** The host registry with the built-in `core` plugin in front, unless disabled or already there. */
function withBuiltins({ registry, builtins = true }: EngineOptions): Registry {
  if (!builtins || registry.plugins.some((p) => p.id === builtinPlugin.id)) return registry;
  return createRegistry([builtinPlugin, ...registry.plugins]);
}

/**
 * Create an engine. Execution is at-least-once per step: committed steps never re-run, but a crash
 * while a handler runs re-runs that step (use `ctx.idempotencyKey` towards external systems).
 * The built-in `core.*` nodes and triggers are available unless `builtins: false`.
 *
 * @example
 * ```ts
 * const engine = createEngine({ registry, storage: createMemoryStorage() });
 * await engine.drain();
 * ```
 */
export function createEngine(options: EngineOptions): Engine {
  const bus = createRunBus(options.storage, options.logger);
  const opts: EngineOptions = {
    ...options,
    registry: withBuiltins(options),
    // Every persisted event feeds the run bus, then the host's listener.
    onEvent: (e) => {
      bus.notify(e);
      options.onEvent?.(e);
    },
  };
  const executor = createExecutor(opts);
  const defaultWorkerId = `worker-${globalThis.crypto.randomUUID().slice(0, 8)}`;

  /** Claim and advance one run; `stop` (a stopping worker) aborts its in-flight `afterCommit`. */
  const claimOnce = async (workerId: string, stop?: AbortSignal): Promise<boolean> => {
    const lease = await opts.storage.claimRun({
      workerId,
      leaseMs: executor.leaseMs,
      now: executor.clock(),
    });
    if (!lease) return false;
    await executor.executeClaim(lease, workerId, stop);
    return true;
  };
  const runOnce = (workerId: string = defaultWorkerId) => claimOnce(workerId);

  const storage = opts.storage;
  const clock = executor.clock;

  const runEvent = (
    run: Pick<Run, "id" | "tenantId">,
    type: RunEventType,
    stepPath: string | undefined,
    data?: unknown,
  ): NewRunEvent => {
    const e: NewRunEvent = { runId: run.id, tenantId: run.tenantId, type, at: clock() };
    if (stepPath !== undefined) e.stepPath = stepPath;
    if (data !== undefined) e.data = data;
    return opts.redact ? opts.redact(e) : e;
  };

  /** Whether the parent of sub-flow run `run` is still suspended on it (so it can be retried). */
  const parentWaitsOn = async (run: Run): Promise<boolean> => {
    if (!run.parent) return false;
    const parent = await storage.getRunById(run.parent.runId);
    if (parent?.status !== "waiting" || parent.waitReason !== "subflow") return false;
    if (parent.currentStep !== run.parent.stepPath) return false;
    const entry = entryAt(parent.journal, run.parent.stepPath);
    const pending = entry?.status === "suspended" ? entry.pending : undefined;
    return pending !== undefined && "childRunId" in pending && pending.childRunId === run.id;
  };

  /** Resume by token; storage appends the `run.resumed` event in the same atomic write. */
  const resumeWithToken = async (token: string, body: unknown, by?: string) => {
    const data = by === undefined ? { kind: "callback" } : { kind: "callback", by };
    const now = clock();
    const run = await storage.resumeByToken(token, { kind: "callback", body }, now, {
      type: "run.resumed",
      data,
    });
    if (!run) return "gone" as const;
    // Report the event storage wrote (the same fields, minus the storage-assigned id and seq).
    const e: NewRunEvent = { runId: run.id, tenantId: run.tenantId, type: "run.resumed", at: now };
    if (run.currentStep !== undefined) e.stepPath = run.currentStep;
    e.data = data;
    executor.publish([e]);
    return "resumed" as const;
  };

  /**
   * Checks a callback resume of `run` against the waiting step's node `resume` declaration:
   * throws when the node is host-handled (and `refuseHostHandled`) or `body` doesn't match
   * `resume.body`.
   */
  const checkResume = async (run: Run, body: unknown, refuseHostHandled: boolean) => {
    const path = run.currentStep;
    if (path === undefined) return;
    const v = await storage.getWorkflowVersion(run.tenantId, run.workflowId, run.version);
    const stepId = path.slice(path.lastIndexOf("/") + 1);
    const step = v ? findStep(v.doc, stepId)?.step : undefined;
    const spec = step ? opts.registry.getNode(step.type)?.resume : undefined;
    if (!spec) return;
    if (refuseHostHandled && spec.hostHandled) {
      throw new ResumeHostHandledError(
        `Step "${stepId}" is resumed by the app, not by the generic resume route`,
      );
    }
    if (!spec.body) return;
    const res = await spec.body.safeParseAsync(body);
    if (res.success) return;
    const issue = res.error.issues[0];
    const field = issue && issue.path.length > 0 ? `field "${issue.path.join(".")}" ` : "";
    const message = `Resume body for step "${stepId}": ${field}${issue?.message ?? "is invalid"}`;
    throw new FlowkitValidationError(message, [
      { code: "config.invalid", severity: "error", message, stepId },
    ]);
  };

  const core: EngineCore = {
    opts,
    registry: opts.registry,
    storage,
    clock,
    ...(opts.logger ? { logger: opts.logger } : {}),
    event: runEvent,
    publish: executor.publish,
  };
  const triggers = createTriggers(core);
  const workflows = createWorkflows(core);

  const engine: Omit<Engine, "handler"> = {
    registry: opts.registry,
    storage,
    runOnce,
    async drain({ maxClaims = 10_000 } = {}) {
      let claims = 0;
      while (claims < maxClaims && (await runOnce())) claims++;
      return claims;
    },

    async resume(token, body) {
      const run = await storage.getRunByCallbackToken(token);
      if (!run || (run.callbackExpiresAt !== undefined && run.callbackExpiresAt <= clock())) {
        return "gone";
      }
      // The same token resumes only the wait that was checked.
      await checkResume(run, body, false);
      return resumeWithToken(token, body);
    },

    async resumeRun(tenantId, runId, body, userId, resumeOpts = {}) {
      const run = await storage.getRun(tenantId, runId);
      const { expectStep, refuseHostHandled = false } = resumeOpts;
      if (expectStep !== undefined && run?.currentStep !== expectStep) return "gone";
      const token = run?.status === "waiting" && run.waitReason === "callback" && run.callbackToken;
      if (!token) return "gone";
      await checkResume(run, body, refuseHostHandled);
      // The token is looked up server-side and never leaves the engine.
      return resumeWithToken(token, body, userId);
    },

    async cancelRun(tenantId, runId) {
      const run = await storage.getRun(tenantId, runId);
      if (!run) throw new Error(`Run "${runId}" not found`);
      if (TERMINAL.has(run.status)) return "finished";
      /** The unleased compare-and-set cancel; `false` when the run is leased or finished. */
      const cancelUnleased = async (current: Run): Promise<boolean> => {
        const events = [runEvent(current, "run.cancelled", current.currentStep)];
        const ok = await storage.updateRunUnleased(
          tenantId,
          runId,
          { status: ["queued", "waiting", "running"] },
          cancelPatch(current),
          events,
          clock(),
        );
        if (ok) executor.publish(events);
        return ok;
      };
      if (await cancelUnleased(run)) return "cancelled";
      // Lost the race: the run finished meanwhile, or a worker holds its lease and must cancel it
      // cooperatively.
      if (!(await storage.requestCancel(tenantId, runId, clock()))) return "finished";
      // The worker may have parked the run (and dropped its lease) between the failed CAS and the
      // request, after its own last check: cancel the now unleased run directly.
      const latest = await storage.getRun(tenantId, runId);
      const leased = latest?.leaseUntil !== undefined && latest.leaseUntil >= clock();
      if (latest && !TERMINAL.has(latest.status) && !leased && (await cancelUnleased(latest))) {
        return "cancelled";
      }
      return "requested";
    },

    async retryRun(tenantId, runId) {
      const run = await storage.getRun(tenantId, runId);
      if (!run) throw new EngineNotFoundError(`Run "${runId}" not found`);
      const failedPath = run.error?.stepPath;
      const patch: RunPatch = {
        status: "queued",
        attempt: 1,
        error: null,
        currentStep: null,
        waitReason: null,
        resume: null,
        wakeAt: null,
        cancelRequestedAt: null,
      };
      if (run.status === "failed" && run.parent && !(await parentWaitsOn(run))) {
        throw new EngineConflictError(
          `Run "${runId}" is a sub-flow whose parent run "${run.parent.runId}" no longer waits on it; retry the parent instead`,
        );
      }
      if (failedPath !== undefined && entryAt(run.journal, failedPath)?.status === "failed") {
        patch.journal = { [failedPath]: null };
      }
      const events = [runEvent(run, "run.resumed", failedPath, { retry: true })];
      const ok =
        run.status === "failed" &&
        (await storage.updateRunUnleased(
          tenantId,
          runId,
          { status: ["failed"] },
          patch,
          events,
          clock(),
        ));
      if (!ok) throw new EngineConflictError(`Run "${runId}" is not failed`);
      executor.publish(events);
      return runId;
    },

    startWorker: (workerOpts) =>
      startWorker(
        {
          runOnce: claimOnce,
          tickSchedules: () => triggers.tickSchedules(),
          defaultWorkerId,
          ...(opts.logger ? { logger: opts.logger } : {}),
        },
        workerOpts,
      ),
    emit: triggers.emit,
    start: triggers.start,
    tickSchedules: triggers.tickSchedules,
    saveWorkflow: workflows.saveWorkflow,
    publish: workflows.publish,
    validate: workflows.validate,
    listSubflows: workflows.listSubflows,
    getRunDetail: workflows.getRunDetail,
    testStep: workflows.testStep,
    subscribe: bus.subscribe,
  };
  const handler = createHandler({ core, engine, triggers });
  return { ...engine, handler };
}
