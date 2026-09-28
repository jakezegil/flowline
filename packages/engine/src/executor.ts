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
  configValueAt,
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
  type SubflowSignal,
  type ValueExpr,
  type WorkflowDoc,
  type WorkflowVersion,
} from "@flowkit/core";
import type { z } from "zod";
import { createNodeContext, newCallbackToken, sha256Hex } from "./context";
import type { EngineOptions } from "./engine";
import { FatalError, RetryableError } from "./errors";
import { buildScope, childSteps, entryAt, type NextAction, nextAction } from "./interpreter";
import { redactBySchema } from "./redact";
import type { Lease, NewRun, NewRunEvent, Run, RunPatch } from "./storage";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_STEPS_PER_CLAIM = 100;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_RETRY: RetryPolicy = { max: 3, backoff: "exponential", initialMs: 1000 };
const MAX_BACKOFF_MS = 3_600_000;
/** Consecutive `renewLease` rejections tolerated before the claim is abandoned. */
const MAX_RENEWAL_ERRORS = 3;
/** Sub-flow levels allowed below a root run. */
const MAX_SUBFLOW_DEPTH = 8;
const DEFAULT_BASE_PATH = "/flowkit";
/** @internal Run statuses that never change again (except through `retryRun`). */
export const TERMINAL: ReadonlySet<Run["status"]> = new Set(["completed", "failed", "cancelled"]);

/** @internal Advances claimed runs. Shared by the engine and crash-injection tests. */
export interface Executor {
  /** Lease duration used for claims and renewals. */
  leaseMs: number;
  /** The engine clock. */
  clock: () => number;
  /**
   * Advance a claimed run until it completes, fails, waits, loses its lease or exhausts the step
   * budget. Resolves once processing stopped; rejects only on infrastructure errors (storage, test
   * hooks), leaving the lease to expire.
   */
  executeClaim(lease: Lease, workerId: string): Promise<void>;
  /** Report persisted events to the engine's `onEvent` listener. */
  publish(events: NewRunEvent[]): void;
}

/** Signals that the lease was taken over; processing stops without committing. */
class LeaseLostError extends Error {
  override readonly name = "LeaseLostError";
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

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const FIELD_CHECKS: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  object: isPlainObject,
  array: (v) => Array.isArray(v),
  date: (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)),
};

/**
 * Why `value` does not match user-declared trigger fields (core's `FieldDecl` list), or
 * `undefined` if it does. Malformed declarations are ignored, as in the editor.
 */
function fieldsProblem(decls: unknown, value: unknown): string | undefined {
  if (!isPlainObject(value)) return "must be an object";
  const record = value;
  for (const decl of Array.isArray(decls) ? decls : []) {
    const { name, type, required } = (decl ?? {}) as Record<string, unknown>;
    if (typeof name !== "string" || typeof type !== "string") continue;
    const v = Object.hasOwn(record, name) ? record[name] : undefined;
    if (v === undefined) {
      if (required === true) return `field "${name}" is required`;
      continue;
    }
    const check = FIELD_CHECKS[type];
    if (check && !check(v)) return `field "${name}" must be of type ${type}`;
  }
  return undefined;
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
  const services = opts.services ?? {};
  const hooks = opts.__testHooks;
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

  async function executeClaim(lease: Lease, workerId: string): Promise<void> {
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

    /** Commit under the lease; `false` means the lease was lost and processing must stop. */
    const commit = async (
      patch: RunPatch,
      events: NewRunEvent[],
      stepPath: string,
      phase: "start" | "result" = "result",
    ) => {
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
      }
      return ok;
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

    const renewIfDue = async (): Promise<boolean> => {
      if (clock() < leaseUntil - leaseMs / 2) return true;
      const ok = await storage.renewLease(lease, leaseMs, clock());
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
      let renewalErrors = 0;
      const renewal = setInterval(() => {
        storage.renewLease(lease, leaseMs, clock()).then(
          (ok) => {
            renewalErrors = 0;
            if (ok) leaseUntil = clock() + leaseMs;
            else controller.abort(new LeaseLostError("lease lost"));
          },
          (err: unknown) => {
            // A transient storage error: keep the claim and try again on the next tick.
            renewalErrors++;
            opts.logger?.warn("lease renewal failed", {
              runId: run.id,
              attempt: renewalErrors,
              error: errorMessage(err),
            });
            if (renewalErrors >= MAX_RENEWAL_ERRORS) {
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

    /** Number of ancestors of this run (0 for a root run), counted up to the nesting cap. */
    const nestingDepth = async (): Promise<number> => {
      let depth = 0;
      let parent = run.parent;
      while (parent && depth < MAX_SUBFLOW_DEPTH) {
        depth++;
        parent = (await storage.getRunById(parent.runId))?.parent;
      }
      return depth;
    };

    /**
     * The trigger payload for a run of `child`, checked against the child trigger's payload schema
     * or declared fields.
     */
    const subflowPayload = async (
      child: WorkflowDoc,
      input: unknown,
    ): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> => {
      let value: unknown;
      try {
        value = structuredClone(input);
      } catch {
        return { ok: false, message: "must be JSON-serializable" };
      }
      const trigger = registry.getTrigger(child.trigger.type);
      if (trigger?.payload) {
        const res = await (trigger.payload as z.ZodType).safeParseAsync(value);
        if (res.success) return { ok: true, value: res.data };
        const issue = res.error.issues[0];
        const field = issue && issue.path.length > 0 ? `field "${issue.path.join(".")}" ` : "";
        return { ok: false, message: `${field}${issue?.message ?? "is invalid"}` };
      }
      if (trigger?.dynamicPayload?.kind === "fields") {
        const decls = configValueAt(child.trigger.config, trigger.dynamicPayload.configPath);
        const problem = fieldsProblem(decls, value);
        if (problem !== undefined) return { ok: false, message: problem };
      }
      return { ok: true, value };
    };

    /**
     * The child run id for the step at `path`: `sub_` + the first 24 hex digits of
     * sha256(`runId:path:attempt`), so re-executing the same call names the same child. If that id
     * already belongs to a finished run (the step was retried with `retryRun`, or the handler
     * starts another sub-flow after resuming), the seed gets a `:n` suffix until the id is free.
     */
    const subflowRunId = async (path: string, stepAttempt: number): Promise<string> => {
      for (let n = 0; ; n++) {
        const seed = `${run.id}:${path}:${stepAttempt}${n === 0 ? "" : `:${n}`}`;
        const id = `sub_${(await sha256Hex(seed)).slice(0, 24)}`;
        const existing = await storage.getRunById(id);
        if (!existing || !TERMINAL.has(existing.status)) return id;
      }
    };

    /**
     * Start the child run of an `invokeSubflow` signal and suspend the step on it: the child is
     * created in the same atomic commit as the parent's suspension, so a crash leaves either both
     * or neither.
     */
    const startSubflow = async (
      sig: SubflowSignal,
      s: {
        path: string;
        attempt: number;
        shownInput: unknown;
        base: { at: number; startedAt: number; input: unknown };
        fatal: (message: string, input?: unknown, code?: string) => Promise<Flow>;
      },
    ): Promise<Flow> => {
      const child = await storage.getPublishedVersion(run.tenantId, sig.workflowId);
      if (!child) {
        return s.fatal(
          `Sub-flow "${sig.workflowId}" is not published`,
          s.shownInput,
          "subflow.unknown",
        );
      }
      if ((await nestingDepth()) >= MAX_SUBFLOW_DEPTH) {
        return s.fatal("Sub-flow nesting too deep", s.shownInput, "subflow.depth");
      }
      const payload = await subflowPayload(child.doc, sig.input);
      if (!payload.ok) {
        return s.fatal(
          `Sub-flow "${sig.workflowId}" input: ${payload.message}`,
          s.shownInput,
          "subflow.input",
        );
      }
      const childRunId = await subflowRunId(s.path, s.attempt);
      const childRun: NewRun = {
        id: childRunId,
        tenantId: run.tenantId,
        workflowId: child.workflowId,
        version: child.version,
        status: "queued",
        trigger: payload.value,
        journal: {},
        attempt: 1,
        startedBy: { kind: "subflow", parentRunId: run.id, parentStepPath: s.path },
        parent: { runId: run.id, stepPath: s.path },
      };
      await commitEntry(
        s.path,
        { status: "suspended", pending: { childRunId }, attempts: s.attempt, ...s.base },
        {
          status: "waiting",
          waitReason: "subflow",
          wakeAt: null,
          currentStep: s.path,
          attempt: 1,
          resume: null,
          createChild: childRun,
        },
        [
          event("run.suspended", s.path, { workflowId: child.workflowId, childRunId }),
          eventFor(childRunId, "run.started"),
        ],
      );
      return "stop";
    };

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

      if (isSignal(result)) {
        if (result.kind === "stop") {
          const output: Record<string, unknown> = { stopped: true };
          const runOutput: Record<string, unknown> = { stoppedAt: path };
          if (result.reason !== undefined) {
            output.reason = result.reason;
            runOutput.reason = result.reason;
          }
          const entry: JournalEntry = { status: "done", output, attempts: attempt, ...base };
          // A stopped sub-flow hands the parent its mapped output when every value it maps exists;
          // otherwise the parent step sees a failed sub-flow.
          const mapped = mapOutput({ ...journal, [path]: entry }, { strict: true });
          const reason = result.reason === undefined ? "" : `: ${result.reason}`;
          await commitEntry(
            path,
            entry,
            {
              ...settled,
              status: "completed",
              output: runOutput,
              ...wakeParent(
                mapped.ok
                  ? { kind: "subflow", output: mapped.output }
                  : { kind: "subflowFailed", error: { message: `Sub-flow stopped${reason}` } },
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
          if (kind === "loop")
            return fatal(`Step "${label}": must return { items: [...] }`, shownInput);
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
          await commitEntry(
            path,
            { status: "suspended", pending, attempts: attempt, ...base },
            patch,
            [event("run.suspended", path, data)],
          );
          return "stop";
        }
        if (result.kind === "subflow") {
          return startSubflow(result, { path, attempt, shownInput, base, fatal });
        }
        return fatal(`Step "${label}": unsupported signal`, shownInput);
      }

      if (kind === "static" || kind === "fromConfig") {
        return fatal(`Step "${label}": must return branch()`, shownInput);
      }
      if (kind === "loop") {
        const items = (result as { items?: unknown } | null)?.items;
        if (!Array.isArray(items))
          return fatal(`Step "${label}": must return { items: [...] }`, shownInput);
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
