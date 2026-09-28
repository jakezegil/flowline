/**
 * `createEngine`: the durable workflow engine over a {@link StorageAdapter}.
 *
 * @module
 */
import type {
  FlowkitServices,
  Logger,
  Registry,
  RunEventType,
  TransformRuntime,
} from "@flowkit/core";
import { createExecutor, TERMINAL } from "./executor";
import { entryAt } from "./interpreter";
import type { NewRunEvent, Run, RunPatch, StorageAdapter } from "./storage";

/** Options of {@link createEngine}. */
export interface EngineOptions {
  /** Plugins, nodes and triggers the engine can run. */
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
  /** Network policy of `ctx.http.fetch`. */
  http?: { allowPrivateNetworks?: boolean; allowHosts?: string[] };
  /** Engine and handler logger. */
  logger?: Logger;
  /** Register the built-in `core.*` plugin. Default `true`. */
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

/** A running engine instance. */
export interface Engine {
  /** The registry the engine executes against. */
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
   */
  resume(token: string, body: unknown): Promise<"resumed" | "gone">;
  /**
   * Resume a callback-waiting run without its token, for authorized callers such as the run
   * viewer. Behaves like {@link Engine.resume} and records `userId` on the `run.resumed` event.
   * Resolves `"gone"` when the run does not exist in the tenant or is not waiting on a callback.
   */
  resumeRun(
    tenantId: string,
    runId: string,
    body: unknown,
    userId: string,
  ): Promise<"resumed" | "gone">;
  /**
   * Cancel a queued or waiting run (or a running one whose worker's lease has expired). A
   * cancelled sub-flow resumes its parent step with `subflowFailed` ("Sub-flow cancelled").
   * Cancelling a parent does NOT cancel its child runs: they run to completion, and their
   * wake-up of the cancelled parent is ignored. Cancelling a finished run does nothing.
   *
   * @throws Error if the run does not exist, or a worker is executing it right now.
   */
  cancelRun(tenantId: string, runId: string): Promise<void>;
  /**
   * Continue a failed run from its failed step: the failed journal entry is removed and the run
   * is queued again (same run id, attempt 1); steps that completed are not re-run. Resolves the
   * run id.
   *
   * @throws Error if the run does not exist or is not failed.
   */
  retryRun(tenantId: string, runId: string): Promise<string>;
}

/**
 * Create an engine. Execution is at-least-once per step: committed steps never re-run, but a crash
 * while a handler runs re-runs that step (use `ctx.idempotencyKey` towards external systems).
 *
 * @example
 * ```ts
 * const engine = createEngine({ registry, storage: createMemoryStorage() });
 * await engine.drain();
 * ```
 */
export function createEngine(opts: EngineOptions): Engine {
  const executor = createExecutor(opts);
  const defaultWorkerId = `worker-${globalThis.crypto.randomUUID().slice(0, 8)}`;

  const runOnce = async (workerId: string = defaultWorkerId): Promise<boolean> => {
    const lease = await opts.storage.claimRun({
      workerId,
      leaseMs: executor.leaseMs,
      now: executor.clock(),
    });
    if (!lease) return false;
    await executor.executeClaim(lease, workerId);
    return true;
  };

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

  /** Append events written outside a run commit and report them. */
  const append = async (events: NewRunEvent[]) => {
    await storage.appendEvents(events);
    executor.publish(events);
  };

  /** Resume by token; the `run.resumed` event is appended right after the storage transition. */
  const resumeWithToken = async (token: string, body: unknown, by?: string) => {
    const run = await storage.resumeByToken(token, { kind: "callback", body }, clock());
    if (!run) return "gone" as const;
    const data = by === undefined ? { kind: "callback" } : { kind: "callback", by };
    await append([runEvent(run, "run.resumed", run.currentStep, data)]);
    return "resumed" as const;
  };

  return {
    registry: opts.registry,
    storage,
    runOnce,
    async drain({ maxClaims = 10_000 } = {}) {
      let claims = 0;
      while (claims < maxClaims && (await runOnce())) claims++;
      return claims;
    },

    resume: (token, body) => resumeWithToken(token, body),

    async resumeRun(tenantId, runId, body, userId) {
      const run = await storage.getRun(tenantId, runId);
      const token = run?.status === "waiting" && run.waitReason === "callback" && run.callbackToken;
      // The token is looked up server-side and never leaves the engine.
      return token ? resumeWithToken(token, body, userId) : "gone";
    },

    async cancelRun(tenantId, runId) {
      const run = await storage.getRun(tenantId, runId);
      if (!run) throw new Error(`Run "${runId}" not found`);
      if (TERMINAL.has(run.status)) return;
      const patch: RunPatch = {
        status: "cancelled",
        wakeAt: null,
        callbackToken: null,
        callbackExpiresAt: null,
      };
      if (run.parent) {
        patch.wakeParent = {
          runId: run.parent.runId,
          stepPath: run.parent.stepPath,
          childRunId: run.id,
          resume: { kind: "subflowFailed", error: { message: "Sub-flow cancelled" } },
        };
      }
      const events = [runEvent(run, "run.cancelled", run.currentStep)];
      const ok = await storage.updateRunUnleased(
        tenantId,
        runId,
        { status: ["queued", "waiting", "running"] },
        patch,
        events,
        clock(),
      );
      if (ok) {
        executor.publish(events);
        return;
      }
      // Lost the race: fine if the run finished meanwhile, otherwise a worker holds its lease.
      const latest = await storage.getRun(tenantId, runId);
      if (latest && TERMINAL.has(latest.status)) return;
      throw new Error(`Run "${runId}" is being executed and cannot be cancelled right now`);
    },

    async retryRun(tenantId, runId) {
      const run = await storage.getRun(tenantId, runId);
      if (!run) throw new Error(`Run "${runId}" not found`);
      const failedPath = run.error?.stepPath;
      const patch: RunPatch = {
        status: "queued",
        attempt: 1,
        error: null,
        currentStep: null,
        waitReason: null,
        resume: null,
        wakeAt: null,
      };
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
      if (!ok) throw new Error(`Run "${runId}" is not failed`);
      executor.publish(events);
      return runId;
    },
  };
}
