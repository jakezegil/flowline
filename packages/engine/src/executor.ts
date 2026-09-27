/**
 * The executor: advances one claimed run through its workflow, committing every step result
 * atomically under the run's lease.
 *
 * @module
 */
import {
  branchesFor,
  collectRefs,
  isRef,
  isSignal,
  isTpl,
  type JournalEntry,
  type NodeDefinition,
  type NodeManifest,
  type RetryPolicy,
  type RunError,
  type RunEventType,
  resolveValue,
  type Step,
  type ValueExpr,
  type WorkflowVersion,
} from "@flowkit/core";
import type { z } from "zod";
import { createNodeContext, sha256Hex } from "./context";
import type { EngineOptions } from "./engine";
import { RetryableError } from "./errors";
import { buildScope, childSteps, entryAt, type NextAction, nextAction } from "./interpreter";
import { redactBySchema } from "./redact";
import type { Lease, NewRunEvent, RunPatch } from "./storage";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_STEPS_PER_CLAIM = 100;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_RETRY: RetryPolicy = { max: 3, backoff: "exponential", initialMs: 1000 };
const MAX_BACKOFF_MS = 3_600_000;
/** Consecutive `renewLease` rejections tolerated before the claim is abandoned. */
const MAX_RENEWAL_ERRORS = 3;

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
}

/** Signals that the lease was taken over; processing stops without committing. */
class LeaseLostError extends Error {
  override readonly name = "LeaseLostError";
}

// biome-ignore lint/suspicious/noExplicitAny: definitions of any input/output types
type AnyNode = NodeDefinition<any, any>;

/** The outcome of one executed step: keep going within this claim, or stop. */
type Flow = "continue" | "stop";

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
    let resume = run.resume;
    let leaseUntil = run.leaseUntil ?? clock() + leaseMs;
    let clearWakeAt = run.wakeAt !== undefined;

    const event = (type: RunEventType, stepPath?: string, data?: unknown): NewRunEvent => {
      const e: NewRunEvent = { runId: run.id, tenantId: run.tenantId, type, at: clock(), workerId };
      if (stepPath !== undefined) e.stepPath = stepPath;
      if (data !== undefined) e.data = data;
      return opts.redact ? opts.redact(e) : e;
    };

    /** Commit under the lease; `false` means the lease was lost and processing must stop. */
    const commit = async (
      patch: RunPatch,
      events: NewRunEvent[],
      stepPath: string,
      phase: "start" | "result" = "result",
    ) => {
      await hooks?.beforeCommit?.(run.id, stepPath, phase);
      const full = clearWakeAt && patch.wakeAt === undefined ? { ...patch, wakeAt: null } : patch;
      const ok = await storage.commit(lease, full, events, clock());
      if (ok) {
        clearWakeAt = false;
        publish(events);
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
      const patch: RunPatch = { status: "failed", error, currentStep: null, waitReason: null };
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
    ): Promise<unknown> => {
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
        });
        const handler = Promise.resolve().then(() => node.run({ input, ctx }));
        handler.catch(() => {});
        return await Promise.race([handler, aborted]);
      } finally {
        clearTimeout(timer);
        clearInterval(renewal);
      }
    };

    const execStep = async (action: Extract<NextAction, { type: "exec" }>): Promise<Flow> => {
      const { step, path } = action;
      const label = step.name ?? step.id;
      const startedAt = clock();
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
      try {
        result = await invoke(node, input, { step, path, scope });
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
          await commitEntry(
            path,
            { status: "done", output, attempts: attempt, ...base },
            { ...settled, status: "completed", output: runOutput },
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
        return fatal(`Step "${label}": ${result.kind} is not supported`, shownInput);
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
      let output: unknown;
      if (doc.output) {
        try {
          const scope = buildScope(doc, journal, "", run.trigger, run.id);
          output = Object.fromEntries(
            Object.entries(doc.output).map(([k, v]) => [k, resolveValue(v, scope)]),
          );
        } catch (err) {
          await failRun({ message: `Workflow output: ${errorMessage(err)}`, fatal: true });
          return;
        }
      }
      const patch: RunPatch = { status: "completed", currentStep: null, waitReason: null };
      if (output !== undefined) patch.output = output;
      if (run.parent) {
        patch.wakeParent = {
          runId: run.parent.runId,
          stepPath: run.parent.stepPath,
          childRunId: run.id,
          resume: { kind: "subflow", output },
        };
      }
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

  return { leaseMs, clock, executeClaim };
}

/** The node's static output schema, or `{}` (nothing to mask) for dynamic outputs. */
function outputSchema(m: NodeManifest) {
  return m.output.kind === "schema" ? m.output.schema : {};
}
