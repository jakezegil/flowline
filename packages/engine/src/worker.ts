/**
 * The polling worker behind `engine.startWorker`.
 *
 * @module
 */
import type { Logger } from "@flowlinejs/core";

/** Options of `Engine.startWorker`. */
export interface WorkerOptions {
  /** Independent claim loops, i.e. runs advanced in parallel. Default `1`. */
  concurrency?: number;
  /** Idle sleep (with ±20% jitter) when a loop finds nothing to run, in ms. Default `500`. */
  pollMs?: number;
  /** Lease owner prefix; each loop uses `<workerId>-<n>`. Default: unique per engine. */
  workerId?: string;
  /** How often the first loop calls `tickSchedules`, in ms. Default `15_000`. */
  scheduleEveryMs?: number;
  /**
   * How often the first loop calls `tickPolls`, in ms. Default `15_000`. A poll trigger's
   * `interval` shorter than this effectively becomes this.
   */
  pollEveryMs?: number;
}

/** A started worker. */
export interface Worker {
  /**
   * Stop claiming new runs and abort in-flight `afterCommit` hooks (recorded as
   * `step.afterCommitFailed`); resolves once in-flight claims, schedule ticks and poll ticks have
   * finished.
   */
  stop(): Promise<void>;
}

/** @internal What the worker drives. */
export interface WorkerDeps {
  /** Claim and advance one run; `stop` aborts when the worker stops. */
  runOnce(workerId: string, stop: AbortSignal): Promise<boolean>;
  tickSchedules(): Promise<number>;
  /** Poll due poll workflows, leasing as `workerId`. */
  tickPolls(workerId: string): Promise<number>;
  defaultWorkerId: string;
  logger?: Logger;
}

/** @internal Start `concurrency` claim loops; the first also ticks schedules and polls. */
export function startWorker(deps: WorkerDeps, opts: WorkerOptions = {}): Worker {
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
  const pollMs = Math.max(0, opts.pollMs ?? 500);
  const scheduleEveryMs = Math.max(1, opts.scheduleEveryMs ?? 15_000);
  const pollEveryMs = Math.max(1, opts.pollEveryMs ?? 15_000);
  const base = opts.workerId ?? deps.defaultWorkerId;
  let stopped = false;
  /** Aborted by `stop()`: cuts in-flight `afterCommit` hooks short. */
  const stopping = new AbortController();
  const wakers = new Set<() => void>();

  /** Sleep `ms`, cut short by `stop()`. */
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (stopped) return resolve();
      const done = () => {
        clearTimeout(timer);
        wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      wakers.add(done);
    });

  const report = (what: string, err: unknown) =>
    deps.logger?.error(what, { error: err instanceof Error ? err.message : String(err) });

  const loop = async (index: number) => {
    const workerId = `${base}-${index}`;
    let nextSchedule = index === 0 ? 0 : Number.POSITIVE_INFINITY;
    let nextPoll = nextSchedule;
    while (!stopped) {
      if (performance.now() >= nextSchedule) {
        nextSchedule = performance.now() + scheduleEveryMs;
        try {
          await deps.tickSchedules();
        } catch (err) {
          report("schedule tick failed", err);
        }
      }
      if (!stopped && performance.now() >= nextPoll) {
        nextPoll = performance.now() + pollEveryMs;
        try {
          await deps.tickPolls(workerId);
        } catch (err) {
          report("poll tick failed", err);
        }
      }
      let claimed = false;
      try {
        claimed = await deps.runOnce(workerId, stopping.signal);
      } catch (err) {
        report("worker claim failed", err);
      }
      if (!claimed && !stopped) {
        let wait = pollMs * (0.8 + Math.random() * 0.4);
        if (index === 0) {
          const nextTick = Math.min(nextSchedule, nextPoll);
          wait = Math.min(wait, Math.max(0, nextTick - performance.now()));
        }
        await sleep(wait);
      }
    }
  };

  const loops = Array.from({ length: concurrency }, (_, i) => loop(i));
  return {
    async stop() {
      stopped = true;
      stopping.abort();
      for (const wake of [...wakers]) wake();
      await Promise.all(loops);
    },
  };
}
