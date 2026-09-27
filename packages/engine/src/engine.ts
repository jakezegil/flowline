/**
 * `createEngine`: the durable workflow engine over a {@link StorageAdapter}.
 *
 * @module
 */
import type { FlowkitServices, Logger, Registry, TransformRuntime } from "@flowkit/core";
import { createExecutor } from "./executor";
import type { NewRunEvent, StorageAdapter } from "./storage";

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

  return {
    registry: opts.registry,
    storage: opts.storage,
    runOnce,
    async drain({ maxClaims = 10_000 } = {}) {
      let claims = 0;
      while (claims < maxClaims && (await runOnce())) claims++;
      return claims;
    },
  };
}
