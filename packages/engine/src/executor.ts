/**
 * The executor: advances one claimed run through its workflow, committing every step result
 * atomically under the run's lease.
 *
 * @module
 */
import {
  branchesFor,
  type CallbackHandle,
  collectRefs,
  type FlowkitServices,
  isRef,
  isSignal,
  isTpl,
  type JournalEntry,
  type NodeDefinition,
  type NodeManifest,
  type ResumeInfo,
  type RetryPolicy,
  type RunError,
  type RunEventType,
  resolveValue,
  type Step,
  type ValueExpr,
  type WorkflowVersion,
} from "@flowkit/core";
import type { z } from "zod";
import { createNodeContext, newCallbackToken, sha256Hex } from "./context";
import type { EngineOptions } from "./engine";
import { FatalError, RetryableError } from "./errors";
import { createGuardedFetch } from "./http";
import { buildScope, childSteps, entryAt, type NextAction, nextAction } from "./interpreter";
import { redactBySchema } from "./redact";
import type { Lease, NewRunEvent, Run, RunPatch } from "./storage";
import { startSubflow, subflowOutputProblem } from "./subflow";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_STEPS_PER_CLAIM = 100;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_RETRY: RetryPolicy = { max: 3, backoff: "exponential", initialMs: 1000 };
const MAX_BACKOFF_MS = 3_600_000;
/** Consecutive `renewLease` rejections tolerated before the claim is abandoned. */
const MAX_RENEWAL_ERRORS = 3;
const DEFAULT_BASE_PATH = "/flowkit";
/** Tries of a suspension's `afterCommit` hook (e.g. a callback notification). */
const AFTER_COMMIT_ATTEMPTS = 3;
/** Delay before the first `afterCommit` retry, doubling after each. */
const AFTER_COMMIT_BACKOFF_MS = 100;
/** Upper bound on one `afterCommit` try; a node's shorter `timeoutMs` applies instead. */
const AFTER_COMMIT_TIMEOUT_MS = 30_000;
/** @internal Run statuses that never change again (except through `retryRun`). */
export const TERMINAL: ReadonlySet<Run["status"]> = new Set(["completed", "failed", "cancelled"]);

/**
 * @internal The patch that cancels `run`, whichever path cancels it: wake-up and callback state
 * cleared and, for a sub-flow run, the parent woken with `subflowFailed` ("Sub-flow cancelled").
 */
export function cancelPatch(run: Pick<Run, "id" | "parent">): RunPatch {
  const patch: RunPatch = {
    status: "cancelled",
    wakeAt: null,
    resume: null,
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
  return patch;
}

/** @internal Advances claimed runs. Shared by the engine and crash-injection tests. */
export interface Executor {
  /** Lease duration used for claims and renewals. */
  leaseMs: number;
  /** The engine clock. */
  clock: () => number;
  /**
   * Advance a claimed run until it completes, fails, waits, loses its lease or exhausts the step
   * budget. Resolves once processing stopped; rejects only on infrastructure errors (storage, test
   * hooks), leaving the lease to expire. `stop` (the worker shutting down) aborts a suspension's
   * in-flight `afterCommit` hook.
   */
  executeClaim(lease: Lease, workerId: string, stop?: AbortSignal): Promise<void>;
  /** Report persisted events to the engine's `onEvent` listener. */
  publish(events: NewRunEvent[]): void;
}

/** An `afterCommit` hook aborted because the worker is stopping; never retried. */
class WorkerStoppedError extends Error {
  override readonly name = "WorkerStoppedError";
}

/** Signals that the lease was taken over; processing stops without committing. */
class LeaseLostError extends Error {
  override readonly name = "LeaseLostError";
}

/** Signals that `cancelRun` flagged the run while a handler ran; the run is cancelled. */
class CancelRequestedError extends Error {
  override readonly name = "CancelRequestedError";
}

// biome-ignore lint/suspicious/noExplicitAny: definitions of any input/output types
type AnyNode = NodeDefinition<any, any>;

/** The outcome of one executed step: keep going within this claim, or stop. */
type Flow = "continue" | "stop";

type Pending = Extract<JournalEntry, { status: "suspended" }>["pending"];

/** `a` overridden by the defined fields of `b`. */
function mergePatch(a: RunPatch, b: RunPatch): RunPatch {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) if (v !== undefined) out[k] = v;
  return out as RunPatch;
}

/** Delay before retrying after failed attempt number `attempt` (1-based). */
function backoffMs(policy: RetryPolicy, attempt: number): number {
  const delay =
    policy.backoff === "fixed" ? policy.initialMs : policy.initialMs * 2 ** (attempt - 1);
  return Math.min(delay, MAX_BACKOFF_MS);
}

/** The node's retry policy, field by field over the defaults (an explicit `undefined` keeps the default). */
function retryPolicy(node: AnyNode): RetryPolicy {
  return {
    max: node.retry?.max ?? DEFAULT_RETRY.max,
    backoff: node.retry?.backoff ?? DEFAULT_RETRY.backoff,
    initialMs: node.retry?.initialMs ?? DEFAULT_RETRY.initialMs,
  };
}

function isFatal(err: unknown): boolean {
  return err instanceof Error && err.name === "FatalError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string | undefined {
  const code =
    typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

/** The config expression at a Zod issue path, for naming the source of a bad value. */
function exprAt(config: Record<string, ValueExpr>, path: PropertyKey[]): ValueExpr | undefined {
  let cur: unknown = config;
  for (const seg of path) {
    if (isRef(cur)) return cur;
    if (typeof cur !== "object" || cur === null) return undefined;
    const key = typeof seg === "symbol" ? undefined : String(seg);
    if (key === undefined || !Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur as ValueExpr | undefined;
}

/**
 * `Step "<label>": field "<key>" <zod message> (from <source>)`, where the source is the ref path,
 * `template "<first ref path>"`, or `literal`.
 */
function inputErrorMessage(label: string, config: Record<string, ValueExpr>, error: z.ZodError) {
  const issue = error.issues[0];
  if (!issue) return `Step "${label}": invalid input`;
  if (issue.path.length === 0) return `Step "${label}": ${issue.message}`;
  const field = issue.path.map(String).join(".");
  const expr = exprAt(config, issue.path);
  const firstTplRef = isTpl(expr) ? collectRefs(expr)[0] : undefined;
  const source = isRef(expr)
    ? expr.$ref
    : firstTplRef !== undefined
      ? `template "${firstTplRef}"`
      : "literal";
  return `Step "${label}": field "${field}" ${issue.message} (from ${source})`;
}

function outputErrorMessage(label: string, error: z.ZodError) {
  const issue = error.issues[0];
  const where = issue && issue.path.length > 0 ? ` at "${issue.path.map(String).join(".")}"` : "";
  return `Step "${label}": output${where} ${issue?.message ?? "is invalid"}`;
}

/** @internal Create the executor for an engine's options. */
export function createExecutor(opts: EngineOptions): Executor {
  const { registry, storage } = opts;
  const clock = opts.clock ?? Date.now;
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const stepsPerClaim = opts.stepsPerClaim ?? DEFAULT_STEPS_PER_CLAIM;
  // Hosts may augment FlowkitServices with required members; without `services` handlers
  // still get an empty object.
  const services = opts.services ?? ({} as FlowkitServices);
  const hooks = opts.__testHooks;
  const http = createGuardedFetch({
    ...opts.http,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  const versions = new Map<string, WorkflowVersion>();
  let manifests: Map<string, NodeManifest> | undefined;

  const nodeManifest = (type: string): NodeManifest | undefined => {
    manifests ??= new Map(registry.manifest().nodes.map((n) => [n.type, n]));
    return manifests.get(type);
  };

  const loadVersion = async (tenantId: string, workflowId: string, version: number) => {
    const key = `${tenantId}:${workflowId}:${version}`;
    let v = versions.get(key);
    if (!v) {
      v = (await storage.getWorkflowVersion(tenantId, workflowId, version)) ?? undefined;
      if (v) versions.set(key, v);
    }
    return v;
  };

  const publish = (events: NewRunEvent[]) => {
    if (!opts.onEvent) return;
    for (const e of events) {
      try {
        opts.onEvent(e);
      } catch (err) {
        opts.logger?.error("onEvent listener threw", { error: errorMessage(err) });
      }
    }
  };

  async function executeClaim(lease: Lease, workerId: string, stop?: AbortSignal): Promise<void> {
    const run = lease.run;
    let journal: Record<string, JournalEntry> = { ...run.journal };
    let attempt = run.attempt;
    let leaseUntil = run.leaseUntil ?? clock() + leaseMs;

    // `ctx.resume` is derived from why the run was waiting, never from token presence. A resume set
    // by storage (callback, subflow, subflowFailed) is used as is; a timer or callback run woken by
    // its `wakeAt` resumes with `timer` / `timeout`. The first commit of this claim (the start
    // commit of the resumed step) persists the derived resume, clears the wake time and — for
    // timeouts — the dead token, and carries the one `run.resumed` event, so a retry or a lost
    // worker later sees the same `ctx.resume` without a second event. A `retry` wait keeps whatever
    // `run.resume` holds. Callback resumes get their `run.resumed` event from `engine.resume`.
    let resume: ResumeInfo | undefined = run.resume;
    let wakePatch: RunPatch | undefined = run.wakeAt !== undefined ? { wakeAt: null } : undefined;
    let resumedKind: ResumeInfo["kind"] | undefined;
    if (!resume && (run.waitReason === "timer" || run.waitReason === "callback")) {
      resume = run.waitReason === "timer" ? { kind: "timer" } : { kind: "timeout" };
      wakePatch = { ...wakePatch, resume, callbackToken: null, callbackExpiresAt: null };
      resumedKind = resume.kind;
    } else if (resume && run.waitReason === "subflow") {
      resumedKind = resume.kind;
    }

    const eventFor = (
      runId: string,
      type: RunEventType,
      stepPath?: string,
      data?: unknown,
    ): NewRunEvent => {
      const e: NewRunEvent = { runId, tenantId: run.tenantId, type, at: clock(), workerId };
      if (stepPath !== undefined) e.stepPath = stepPath;
      if (data !== undefined) e.data = data;
      return opts.redact ? opts.redact(e) : e;
    };
    const event = (type: RunEventType, stepPath?: string, data?: unknown) =>
      eventFor(run.id, type, stepPath, data);

    /** A wake-up of the parent run in this (terminal) commit, for sub-flow runs. */
    const wakeParent = (info: ResumeInfo): Pick<RunPatch, "wakeParent"> =>
      run.parent
        ? {
            wakeParent: {
              runId: run.parent.runId,
              stepPath: run.parent.stepPath,
              childRunId: run.id,
              resume: info,
            },
          }
        : {};

    /**
     * Commit under the lease; `false` means processing must stop (the lease was lost, or the run
     * was cancelled instead). A commit that gives the run up without finishing it (`waiting`, or
     * `queued` again) first honours a pending cancel request, so a flagged run is not parked.
     */
    const commit = async (
      patch: RunPatch,
      events: NewRunEvent[],
      stepPath: string,
      phase: "start" | "result" = "result",
    ): Promise<boolean> => {
      if (
        (patch.status === "waiting" || patch.status === "queued") &&
        (await cancelIfRequested(stepPath))
      ) {
        return false;
      }
      await hooks?.beforeCommit?.(run.id, stepPath, phase);
      const full = wakePatch ? mergePatch(wakePatch, patch) : patch;
      const all =
        resumedKind !== undefined
          ? [event("run.resumed", run.currentStep, { kind: resumedKind }), ...events]
          : events;
      const ok = await storage.commit(lease, full, all, clock());
      if (ok) {
        wakePatch = undefined;
        resumedKind = undefined;
        publish(all);
        // A request that arrived after the check above but before this park found the run still
        // leased (so `cancelRun` only flagged it). The run is unleased now: cancel it directly.
        if (patch.status === "waiting" || patch.status === "queued") await cancelParked(stepPath);
      }
      return ok;
    };

    /**
     * Cancel the run under the lease (see `Engine.cancelRun`): the same transition as an unleased
     * cancel, including the parent's `subflowFailed` wake-up. A `run.resumed` still owed by this
     * claim is dropped, since the run never resumes.
     */
    const cancelUnderLease = async (stepPath: string): Promise<void> => {
      resumedKind = undefined;
      await commit(
        cancelPatch(run),
        [event("run.cancelled", stepPath === "" ? undefined : stepPath)],
        stepPath,
      );
    };

    /** After parking the run: cancel it (unleased CAS) if a cancel request is pending. */
    const cancelParked = async (stepPath: string): Promise<void> => {
      const latest = await storage.getRun(run.tenantId, run.id);
      if (latest?.cancelRequestedAt === undefined) return;
      const events = [event("run.cancelled", stepPath === "" ? undefined : stepPath)];
      const ok = await storage.updateRunUnleased(
        run.tenantId,
        run.id,
        { status: ["waiting", "queued"] },
        cancelPatch(run),
        events,
        clock(),
      );
      // Losing the CAS means another worker claimed the run; its after-claim check cancels it.
      if (ok) publish(events);
    };

    /** Whether cancellation of this run was requested; reads the run row. */
    const cancelRequested = async (): Promise<boolean> =>
      (await storage.getRunById(run.id))?.cancelRequestedAt !== undefined;

    /** Cancel the run if that was requested; `true` when it was (processing must stop). */
    const cancelIfRequested = async (stepPath: string): Promise<boolean> => {
      if (!(await cancelRequested())) return false;
      await cancelUnderLease(stepPath);
      return true;
    };

    /** Commit a journal entry for `path` and adopt it locally. */
    const commitEntry = async (
      path: string,
      entry: JournalEntry,
      patch: RunPatch,
      events: NewRunEvent[],
    ): Promise<boolean> => {
      const ok = await commit({ ...patch, journal: { [path]: entry } }, events, path);
      if (ok) journal = { ...journal, [path]: entry };
      return ok;
    };

    /** Whether the run still waits on the suspension `path` parked (with `issued`, if any). */
    const stillParked = async (path: string, issued: CallbackHandle | undefined) => {
      const latest = await storage.getRunById(run.id);
      return (
        latest?.status === "waiting" &&
        latest.currentStep === path &&
        (issued ? latest.callbackToken === issued.token : latest.waitReason === "timer")
      );
    };

    /** One try of an `afterCommit` hook, rejecting at `timeoutMs` or when the worker stops. */
    const tryHook = async (
      hook: (opts: { signal: AbortSignal }) => Promise<void>,
      timeoutMs: number,
    ): Promise<void> => {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new RetryableError(`afterCommit timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      const onStop = () => controller.abort(new WorkerStoppedError("worker stopped"));
      if (stop?.aborted) onStop();
      else stop?.addEventListener("abort", onStop, { once: true });
      const aborted = new Promise<never>((_, reject) => {
        const fail = () => reject(controller.signal.reason);
        if (controller.signal.aborted) fail();
        else controller.signal.addEventListener("abort", fail, { once: true });
      });
      try {
        const running = Promise.resolve().then(() => hook({ signal: controller.signal }));
        running.catch(() => {});
        await Promise.race([running, aborted]);
      } finally {
        clearTimeout(timer);
        stop?.removeEventListener("abort", onStop);
      }
    };

    /**
     * Run a suspension's `afterCommit` once its park commit succeeded: best effort, at most once (a
     * crash before this point skips it). Up to {@link AFTER_COMMIT_ATTEMPTS} tries, each bounded
     * by the node's `timeoutMs` (at most {@link AFTER_COMMIT_TIMEOUT_MS}) and aborted when the
     * worker stops; only a `RetryableError` or a timeout is retried, and only while the run still
     * waits on this suspension (it holds no lease, so it may have been resumed or cancelled
     * meanwhile). The park released the lease, so a final failure appends a `step.afterCommitFailed`
     * event (error message with the callback's token and URL masked) instead of a guarded commit,
     * logs a warning and leaves the run waiting.
     */
    const runAfterCommit = async (
      path: string,
      hook: (opts: { signal: AbortSignal }) => Promise<void>,
      issued: CallbackHandle | undefined,
      node: AnyNode,
    ): Promise<void> => {
      const timeoutMs = Math.min(
        node.timeoutMs ?? AFTER_COMMIT_TIMEOUT_MS,
        AFTER_COMMIT_TIMEOUT_MS,
      );
      for (let n = 1; ; n++) {
        try {
          await tryHook(hook, timeoutMs);
          return;
        } catch (err) {
          const retryable = err instanceof Error && err.name === "RetryableError";
          if (retryable && n < AFTER_COMMIT_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, AFTER_COMMIT_BACKOFF_MS * 2 ** (n - 1)));
            if (await stillParked(path, issued)) continue;
            return;
          }
          if (!(err instanceof WorkerStoppedError) && !(await stillParked(path, issued))) return;
          let message = errorMessage(err);
          for (const s of issued ? [issued.resumeUrl, issued.token] : []) {
            message = message.split(s).join("[redacted]");
          }
          opts.logger?.warn("after-commit hook failed", {
            runId: run.id,
            stepPath: path,
            error: message,
          });
          const events = [
            event("step.afterCommitFailed", path, { error: { message }, attempts: n }),
          ];
          try {
            await storage.appendEvents(events);
            publish(events);
          } catch (appendErr) {
            opts.logger?.warn("could not record step.afterCommitFailed", {
              runId: run.id,
              error: errorMessage(appendErr),
            });
          }
          return;
        }
      }
    };

    /** Clears the per-step wait state once a step's entry is final (done/branched/looping). */
    const settled: RunPatch = { attempt: 1, currentStep: null, waitReason: null, resume: null };
    const settle = () => {
      attempt = 1;
      resume = undefined;
    };

    const failRun = async (error: RunError, failed?: { path: string; entry: JournalEntry }) => {
      const patch: RunPatch = {
        status: "failed",
        error,
        currentStep: null,
        waitReason: null,
        resume: null,
        callbackToken: null,
        callbackExpiresAt: null,
        ...wakeParent({ kind: "subflowFailed", error: { message: error.message } }),
      };
      const events = [event("run.failed", error.stepPath, { error })];
      if (failed) {
        events.unshift(event("step.failed", failed.path, { error }));
        await commitEntry(failed.path, failed.entry, patch, events);
      } else {
        await commit(patch, events, "");
      }
      return "stop" as const;
    };

    // Cancellation requested while the run was leased (or parked, see `Engine.cancelRun`).
    if (run.cancelRequestedAt !== undefined) {
      await cancelUnderLease(run.currentStep ?? "");
      return;
    }

    const version = await loadVersion(run.tenantId, run.workflowId, run.version);
    if (!version) {
      await failRun({
        message: `Workflow "${run.workflowId}" version ${run.version} not found`,
        fatal: true,
      });
      return;
    }
    const doc = version.doc;

    // A step that was marked in flight (`currentStep` set by the start commit, no wait reason) but
    // never settled: the previous worker died or lost its lease while running it. That attempt
    // counts against the step's retry budget, so a handler that crashes its worker is not re-run
    // forever.
    const current = run.currentStep;
    const currentEntry = current === undefined ? undefined : entryAt(journal, current);
    let lostInFlight =
      current !== undefined &&
      run.waitReason === undefined &&
      currentEntry?.status !== "done" &&
      currentEntry?.status !== "branched" &&
      currentEntry?.status !== "looping" &&
      currentEntry?.status !== "skipped"
        ? current
        : undefined;

    // Consecutive `renewLease` rejections across this claim (between-steps and in-handler renewals
    // alike); any settled renewal resets it.
    let renewalErrors = 0;
    /**
     * Record a transient renewal error: the claim is kept (and renewal retried) until
     * `MAX_RENEWAL_ERRORS` consecutive errors. Returns `false` once the claim must be abandoned.
     */
    const renewalFailed = (err: unknown): boolean => {
      renewalErrors++;
      opts.logger?.warn("lease renewal failed", {
        runId: run.id,
        attempt: renewalErrors,
        error: errorMessage(err),
      });
      return renewalErrors < MAX_RENEWAL_ERRORS;
    };

    const renewIfDue = async (): Promise<boolean> => {
      if (clock() < leaseUntil - leaseMs / 2) return true;
      let ok: boolean;
      try {
        ok = await storage.renewLease(lease, leaseMs, clock());
      } catch (err) {
        // A transient storage error: keep going; the next step boundary or tick tries again.
        return renewalFailed(err);
      }
      renewalErrors = 0;
      if (ok) leaseUntil = clock() + leaseMs;
      return ok;
    };

    const invoke = async (
      node: AnyNode,
      input: unknown,
      ctxArgs: {
        step: Step;
        path: string;
        scope: ReturnType<typeof buildScope>;
      },
    ): Promise<{ result: unknown; issued: CallbackHandle | undefined }> => {
      // The callback issued by this invocation. Its token lives only here until the suspend
      // commit stores it on the run; it is never journaled or put into events.
      let issued: CallbackHandle | undefined;
      const callback = async ({ timeoutMs }: { timeoutMs: number }) => {
        if (typeof timeoutMs !== "number" || !(timeoutMs > 0) || !Number.isFinite(timeoutMs)) {
          throw new FatalError("ctx.callback() needs a positive timeoutMs");
        }
        if (issued) throw new FatalError("callback already issued for this step");
        const token = newCallbackToken();
        issued = {
          token,
          resumeUrl: `${opts.publicUrl ?? ""}${opts.basePath ?? DEFAULT_BASE_PATH}/resume/${token}`,
          expiresAt: clock() + timeoutMs,
        };
        return { ...issued };
      };
      const controller = new AbortController();
      const timeoutMs = node.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      // The handler is not killed at the timeout: it may keep running while the retry starts, which
      // is why handlers must honour `ctx.signal` and pass `ctx.idempotencyKey` downstream.
      const timer = setTimeout(() => controller.abort(new RetryableError("timed out")), timeoutMs);
      const renewal = setInterval(() => {
        storage.renewLease(lease, leaseMs, clock()).then(
          async (ok) => {
            renewalErrors = 0;
            if (!ok) {
              controller.abort(new LeaseLostError("lease lost"));
              return;
            }
            leaseUntil = clock() + leaseMs;
            // Each renewal also polls for a cancel request, so a long handler is aborted promptly.
            try {
              if (await cancelRequested()) {
                controller.abort(new CancelRequestedError("run cancelled"));
              }
            } catch (err) {
              opts.logger?.warn("cancel check failed", { runId: run.id, error: errorMessage(err) });
            }
          },
          (err: unknown) => {
            // A transient storage error: keep the claim and try again on the next tick.
            if (!renewalFailed(err)) {
              controller.abort(new LeaseLostError("lease renewal failed repeatedly"));
            }
          },
        );
      }, leaseMs / 2);
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
          once: true,
        });
      });
      // The losing side of the race must not surface as an unhandled rejection.
      aborted.catch(() => {});
      try {
        const ctx = createNodeContext({
          runId: run.id,
          tenantId: run.tenantId,
          workflowId: run.workflowId,
          stepId: ctxArgs.step.id,
          stepPath: ctxArgs.path,
          attempt,
          idempotencyKey: await sha256Hex(`${run.id}:${ctxArgs.path}`),
          services,
          ...(opts.logger ? { logger: opts.logger } : {}),
          signal: controller.signal,
          clock,
          ...(resume ? { resume } : {}),
          scope: ctxArgs.scope,
          ...(opts.secrets ? { secrets: opts.secrets } : {}),
          ...(opts.transform ? { transform: opts.transform } : {}),
          http,
          callback,
        });
        const handler = Promise.resolve().then(() => node.run({ input, ctx }));
        handler.catch(() => {});
        const result = await Promise.race([handler, aborted]);
        return { result, issued };
      } finally {
        clearTimeout(timer);
        clearInterval(renewal);
      }
    };

    /**
     * Evaluate the workflow's output mapping against `j`'s end-of-run scope. `strict` also requires
     * every referenced value to exist (used for stopped sub-flows, whose later steps never ran).
     */
    const mapOutput = (
      j: Record<string, JournalEntry>,
      { strict = false } = {},
    ): { ok: true; output: unknown } | { ok: false; message: string } => {
      if (!doc.output) return { ok: true, output: undefined };
      try {
        const scope = buildScope(doc, j, "", run.trigger, run.id);
        const entries = Object.entries(doc.output);
        if (strict) {
          const missing = entries
            .flatMap(([, v]) => collectRefs(v))
            .find((ref) => resolveValue({ $ref: ref }, scope) === undefined);
          if (missing !== undefined) return { ok: false, message: `"${missing}" is not set` };
        }
        return {
          ok: true,
          output: Object.fromEntries(entries.map(([k, v]) => [k, resolveValue(v, scope)])),
        };
      } catch (err) {
        return { ok: false, message: errorMessage(err) };
      }
    };

    /** For a sub-flow run: why its mapped output breaks the declared output fields, if it does. */
    const childOutputProblem = (output: unknown): string | undefined =>
      run.parent ? subflowOutputProblem(registry, doc, output) : undefined;

    const execStep = async (action: Extract<NextAction, { type: "exec" }>): Promise<Flow> => {
      const { step, path } = action;
      const label = step.name ?? step.id;
      // A resumed step keeps the start time of its first invocation.
      const prior = entryAt(journal, path);
      const startedAt = prior?.status === "suspended" ? prior.startedAt : clock();
      const fatal = (message: string, input?: unknown, code?: string) => {
        const error: RunError = { message, stepPath: path, fatal: true };
        if (code !== undefined) error.code = code;
        const entry: JournalEntry = {
          status: "failed",
          error,
          at: clock(),
          startedAt,
          attempts: attempt,
        };
        if (input !== undefined) entry.input = input;
        return failRun(error, { path, entry });
      };

      const node = registry.getNode(step.type);
      const manifest = nodeManifest(step.type);
      if (!node || !manifest) return fatal(`Step "${label}": unknown node type "${step.type}"`);

      if (lostInFlight === path) {
        lostInFlight = undefined;
        if (attempt >= retryPolicy(node).max) {
          const error: RunError = {
            message: `worker lost during step (${attempt} attempts)`,
            stepPath: path,
          };
          return failRun(error, {
            path,
            entry: { status: "failed", error, at: clock(), startedAt, attempts: attempt },
          });
        }
        attempt++;
      }

      const scope = buildScope(doc, journal, path, run.trigger, run.id);
      let resolved: Record<string, unknown>;
      try {
        resolved = structuredClone(
          Object.fromEntries(
            Object.entries(step.config).map(([k, v]) => [k, resolveValue(v, scope)]),
          ),
        );
      } catch (err) {
        return fatal(`Step "${label}": ${errorMessage(err)}`);
      }
      const parsed = await node.input.safeParseAsync(resolved);
      if (!parsed.success) {
        return fatal(
          inputErrorMessage(label, step.config, parsed.error),
          redactBySchema(resolved, manifest.input, { mask: "secret" }),
        );
      }
      const input: unknown = parsed.data;
      // Journal copies mask only secrets; event copies also mask sensitive values.
      const shownInput = redactBySchema(input, manifest.input, { mask: "secret" });
      const eventInput = redactBySchema(input, manifest.input, { mask: "all" });
      const outSchema = outputSchema(manifest);
      const eventOutput = (v: unknown) => redactBySchema(v, outSchema, { mask: "all" });

      if (!(await renewIfDue())) return "stop";
      if (await cancelIfRequested(path)) return "stop";
      // Mark the step in flight (lease-guarded) so a worker that later finds it unsettled knows an
      // attempt was lost.
      const startOk = await commit(
        { currentStep: path, waitReason: null, attempt },
        [event("step.started", path, { input: eventInput })],
        path,
        "start",
      );
      if (!startOk) return "stop";

      let result: unknown;
      let issued: CallbackHandle | undefined;
      try {
        ({ result, issued } = await invoke(node, input, { step, path, scope }));
      } catch (err) {
        if (err instanceof LeaseLostError) return "stop";
        if (err instanceof CancelRequestedError) {
          await cancelUnderLease(path);
          return "stop";
        }
        const message = errorMessage(err);
        const code = errorCode(err);
        if (isFatal(err)) return fatal(message, shownInput, code);
        const policy = retryPolicy(node);
        if (attempt < policy.max) {
          const delayMs = backoffMs(policy, attempt);
          await commit(
            {
              status: "waiting",
              waitReason: "retry",
              wakeAt: clock() + delayMs,
              attempt: attempt + 1,
              currentStep: path,
              release: true,
            },
            [event("step.retrying", path, { attempt, delayMs, error: message })],
            path,
          );
          return "stop";
        }
        const error: RunError = { message, stepPath: path };
        if (code !== undefined) error.code = code;
        return failRun(error, {
          path,
          entry: {
            status: "failed",
            error,
            at: clock(),
            startedAt,
            attempts: attempt,
            input: shownInput,
          },
        });
      }

      const validateOutput = async (
        value: unknown,
      ): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> => {
        let out = value;
        if (node.output) {
          const res = await (node.output as z.ZodType).safeParseAsync(value);
          if (!res.success) return { ok: false, message: outputErrorMessage(label, res.error) };
          out = res.data;
        }
        try {
          return { ok: true, value: structuredClone(out) };
        } catch {
          return { ok: false, message: `Step "${label}": output must be JSON-serializable` };
        }
      };

      const kind = manifest.branches.kind;
      const base = { at: clock(), startedAt, input: shownInput };

      /** Start iterating a loop node's `body` over `items`. */
      const startLoop = async (items: unknown): Promise<Flow> => {
        if (!Array.isArray(items)) {
          return fatal(`Step "${label}": must return loop(items) with a list`, shownInput);
        }
        let copy: unknown[];
        try {
          copy = structuredClone(items);
        } catch {
          return fatal(`Step "${label}": items must be JSON-serializable`, shownInput);
        }
        const { at, input: loopInput } = base;
        const ok = await commitEntry(
          path,
          {
            status: "looping",
            items: copy,
            results: [],
            at,
            startedAt,
            attempts: attempt,
            input: loopInput,
          },
          settled,
          [],
        );
        if (ok) settle();
        return ok ? "continue" : "stop";
      };

      if (isSignal(result)) {
        if (result.kind === "loop") {
          if (kind !== "loop") {
            return fatal(`Step "${label}": loop() is only for looping nodes`, shownInput);
          }
          return startLoop(result.items);
        }
        if (result.kind === "stop") {
          const output: Record<string, unknown> = { stopped: true };
          const runOutput: Record<string, unknown> = { stoppedAt: path };
          if (result.reason !== undefined) {
            output.reason = result.reason;
            runOutput.reason = result.reason;
          }
          const entry: JournalEntry = { status: "done", output, attempts: attempt, ...base };
          // A stopped sub-flow hands the parent its mapped output when every value it maps exists
          // and matches the declared output fields; otherwise the parent step sees a failed
          // sub-flow (the stopped run itself still completes).
          const mapped = mapOutput({ ...journal, [path]: entry }, { strict: true });
          const reason = result.reason === undefined ? "" : `: ${result.reason}`;
          const problem = mapped.ok ? childOutputProblem(mapped.output) : undefined;
          await commitEntry(
            path,
            entry,
            {
              ...settled,
              status: "completed",
              output: runOutput,
              ...wakeParent(
                !mapped.ok
                  ? { kind: "subflowFailed", error: { message: `Sub-flow stopped${reason}` } }
                  : problem !== undefined
                    ? { kind: "subflowFailed", error: { message: problem } }
                    : { kind: "subflow", output: mapped.output },
              ),
            },
            [
              event("step.completed", path, { input: eventInput, output }),
              event("run.stopped", path, runOutput),
            ],
          );
          return "stop";
        }
        if (result.kind === "branch") {
          if (kind === "loop") return fatal(`Step "${label}": must return loop(items)`, shownInput);
          const allowed = branchesFor(manifest, step).map((b) => b.id);
          if (!allowed.includes(result.branch)) {
            return fatal(`Step "${label}": returned unknown branch "${result.branch}"`, shownInput);
          }
          // `branch(id)` without output is always valid: the output schema is not applied.
          let raw: unknown;
          if (result.output !== undefined) {
            const checked = await validateOutput(result.output);
            if (!checked.ok) return fatal(checked.message, shownInput);
            raw = checked.value;
          }
          const output = redactBySchema(raw, outSchema, { mask: "secret" });
          const ok = await commitEntry(
            path,
            { status: "branched", branch: result.branch, output, attempts: attempt, ...base },
            settled,
            [
              event("step.completed", path, {
                input: eventInput,
                output: eventOutput(raw),
                branch: result.branch,
              }),
            ],
          );
          if (ok) settle();
          return ok ? "continue" : "stop";
        }
        if (result.kind === "suspend") {
          // A suspended step is not settled: `currentStep` stays set, and the wait reason marks it
          // as waiting rather than lost. The resumed invocation starts a fresh attempt count.
          const patch: RunPatch = {
            status: "waiting",
            currentStep: path,
            attempt: 1,
            resume: null,
          };
          let pending: Pending;
          let data: Record<string, unknown>;
          if ("until" in result) {
            if (typeof result.until !== "number" || !Number.isFinite(result.until)) {
              return fatal(
                `Step "${label}": suspend({ until }) needs an epoch ms time`,
                shownInput,
              );
            }
            pending = { until: result.until };
            data = { until: result.until };
            Object.assign(patch, { waitReason: "timer", wakeAt: result.until });
          } else {
            if (!issued || result.callback?.token !== issued.token) {
              return fatal(
                `Step "${label}": suspend({ callback }) needs the handle ctx.callback() returned`,
                shownInput,
              );
            }
            const { expiresAt } = issued;
            // Only the run row holds the token; the journal and events never see it (nor the URL).
            pending = { hasCallback: true, expiresAt };
            data = { callback: true, expiresAt };
            Object.assign(patch, {
              waitReason: "callback",
              wakeAt: expiresAt,
              callbackToken: issued.token,
              callbackExpiresAt: expiresAt,
            });
          }
          const parked = await commitEntry(
            path,
            { status: "suspended", pending, attempts: attempt, ...base },
            patch,
            [event("run.suspended", path, data)],
          );
          // Only now does the callback's token exist in storage, so its URL works.
          if (parked && result.afterCommit) {
            await runAfterCommit(path, result.afterCommit, issued, node);
          }
          return "stop";
        }
        if (result.kind === "subflow") {
          // The child is created in the same atomic commit as the parent's suspension, so a crash
          // leaves either both or neither.
          return startSubflow<Flow>(result, {
            storage,
            registry,
            run,
            path,
            attempt,
            fail: (message, code) => fatal(message, shownInput, code),
            suspend: async (child) => {
              await commitEntry(
                path,
                {
                  status: "suspended",
                  pending: { childRunId: child.id },
                  attempts: attempt,
                  ...base,
                },
                {
                  status: "waiting",
                  waitReason: "subflow",
                  wakeAt: null,
                  currentStep: path,
                  attempt: 1,
                  resume: null,
                  createChild: child,
                },
                [
                  event("run.suspended", path, {
                    workflowId: child.workflowId,
                    childRunId: child.id,
                  }),
                  eventFor(child.id, "run.started"),
                ],
              );
              return "stop";
            },
          });
        }
        return fatal(`Step "${label}": unsupported signal`, shownInput);
      }

      if (kind === "static" || kind === "fromConfig") {
        return fatal(`Step "${label}": must return branch()`, shownInput);
      }
      if (kind === "loop") {
        // Back-compat: a plain `{ items }` return works like `loop(items)`.
        return startLoop((result as { items?: unknown } | null)?.items);
      }

      const checked = await validateOutput(result);
      if (!checked.ok) return fatal(checked.message, shownInput);
      const output = redactBySchema(checked.value, outSchema, { mask: "secret" });
      const ok = await commitEntry(
        path,
        { status: "done", output, attempts: attempt, ...base },
        settled,
        [event("step.completed", path, { input: eventInput, output: eventOutput(checked.value) })],
      );
      if (ok) settle();
      return ok ? "continue" : "stop";
    };

    const completeBlock = async (step: Step, path: string): Promise<Flow> => {
      const e = entryAt(journal, path);
      let entry: JournalEntry;
      const events: NewRunEvent[] = [];
      if (e?.status === "branched") {
        const { status: _status, ...rest } = e;
        entry = { ...rest, status: "done", at: clock() };
      } else if (e?.status === "looping") {
        const body = childSteps(step, "body");
        // Each iteration's result is the output of its last finished body step, masked for the
        // event by that step's own output schema.
        const results: unknown[] = [];
        const eventResults: unknown[] = [];
        for (let i = 0; i < e.items.length; i++) {
          let result: unknown = null;
          let shown: unknown = null;
          for (let k = body.length - 1; k >= 0; k--) {
            const inner = body[k];
            const innerEntry = inner && entryAt(journal, `${path}/body[${i}]/${inner.id}`);
            if (inner && innerEntry?.status === "done") {
              result = innerEntry.output ?? null;
              const m = nodeManifest(inner.type);
              shown = m ? redactBySchema(result, outputSchema(m), { mask: "all" }) : result;
              break;
            }
          }
          results.push(result);
          eventResults.push(shown);
        }
        const count = e.items.length;
        const output = { count, results };
        entry = {
          status: "done",
          output,
          at: clock(),
          startedAt: e.startedAt,
          attempts: e.attempts ?? 1,
        };
        if (e.input !== undefined) entry.input = e.input;
        const m = nodeManifest(step.type);
        const eventInput = m ? redactBySchema(e.input, m.input, { mask: "all" }) : e.input;
        events.push(
          event("step.completed", path, {
            input: eventInput,
            output: { count, results: eventResults },
          }),
        );
      } else {
        return "stop";
      }
      return (await commitEntry(path, entry, {}, events)) ? "continue" : "stop";
    };

    const completeRun = async (): Promise<void> => {
      const mapped = mapOutput(journal);
      if (!mapped.ok) {
        await failRun({ message: `Workflow output: ${mapped.message}`, fatal: true });
        return;
      }
      const { output } = mapped;
      const problem = childOutputProblem(output);
      if (problem !== undefined) {
        await failRun({ message: problem, fatal: true, code: "subflow.output" });
        return;
      }
      const patch: RunPatch = {
        status: "completed",
        currentStep: null,
        waitReason: null,
        ...wakeParent({ kind: "subflow", output }),
      };
      if (output !== undefined) patch.output = output;
      await commit(
        patch,
        // The output mapping may carry sensitive step values, so the event does not copy it.
        [event("run.completed")],
        "",
      );
    };

    for (let n = 0; n < stepsPerClaim; n++) {
      const action = nextAction(doc, journal, registry);
      if (action.type === "complete") {
        await completeRun();
        return;
      }
      let flow: Flow;
      if (action.type === "skip") {
        const ok = await commitEntry(action.path, { status: "skipped", at: clock() }, {}, [
          event("step.skipped", action.path),
        ]);
        flow = ok ? "continue" : "stop";
      } else if (action.type === "completeBlock") {
        flow = await completeBlock(action.step, action.path);
      } else {
        flow = await execStep(action);
      }
      if (flow === "stop") return;
    }
    await commit({ status: "queued", release: true }, [], "");
  }

  return { leaseMs, clock, executeClaim, publish };
}

/** The node's static output schema, or `{}` (nothing to mask) for dynamic outputs. */
function outputSchema(m: NodeManifest) {
  return m.output.kind === "schema" ? m.output.schema : {};
}
