/**
 * Starting runs: `engine.emit` (event triggers), `engine.start` (manual/code), inbound webhooks,
 * cron schedules (`engine.tickSchedules`) and poll triggers (`engine.tickPolls`).
 *
 * Deduplication: every run gets a random ID (`run_<32 hex>`). A start with a dedupe key
 * atomically claims the key for that ID (`claimDedupeKey`), so of any number of deliveries
 * (concurrent ones, or in several processes) exactly one starts a run and the others resolve its
 * ID, and a delivery retried after a crash between the claim and the run's creation still creates
 * it. A key suppresses duplicates only for its window (call → trigger → engine
 * `dedupe.defaultWindow`, default 7 days); a delivery after that starts a new run with a fresh ID,
 * whether or not the first run has finished. Keys are namespaced per workflow:
 * `event:<wf>:<key>`, `start:<wf>:<key>`, `webhook:<wf>:<key>`, `schedule:<wf>:<fireAt>`, `poll:<wf>:<itemKey>`.
 *
 * @module
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  type DurationInput,
  FlowlineDefinitionError,
  type FlowlineServices,
  type Issue,
  type PollContext,
  type RunOrigin,
  type TriggerDefinition,
  type WorkflowVersion,
} from "@flowlinejs/core";
import { CronExpressionParser } from "cron-parser";
import { parseWindow } from "./duration";
import type { EngineCore } from "./engine";
import { FlowlineValidationError } from "./errors";
import type { NewRunEvent, PollPatch } from "./storage";
import { checkTriggerPayload, visibleTriggerConfig } from "./subflow";
import { errorMessage } from "./util";

/** Default of `EngineOptions.dedupe.defaultWindow`. */
const DEFAULT_DEDUPE_WINDOW = "7d";

/** Request headers never stored in a webhook run's `trigger.headers`. */
const DROPPED_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "x-flowline-signature",
]);
/** Header names that likely carry credentials (`x-api-key`, `stripe-signature`, `x-auth-token`…). */
const CREDENTIAL_HEADER = /signature|api-?key|token|secret|password|auth/;

/** Whether a (lowercased) request header is kept in a webhook run's `trigger.headers`. */
function keptHeader(name: string): boolean {
  return !DROPPED_HEADERS.has(name) && !name.startsWith("proxy-") && !CREDENTIAL_HEADER.test(name);
}

/** A validation issue about a trigger payload or run input. */
function payloadIssue(message: string): Issue {
  return { code: "config.invalid", severity: "error", message };
}

/** A literal string in (visible) trigger config, or `undefined`. */
function configString(
  config: WorkflowVersion["doc"]["trigger"]["config"],
  key: string,
): string | undefined {
  const value = config[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Constant-time string equality (compares SHA-256 digests, so lengths may differ). */
function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

/** The outcome of an inbound webhook delivery, mapped to an HTTP status by the handler. */
export type WebhookResult =
  | { status: "notFound" }
  | { status: "unauthorized" }
  | { status: "invalid"; message: string; issues: Issue[] }
  /** The trigger's `filter` returned `false`; no run was started. */
  | { status: "skipped" }
  | { status: "started"; runId: string; deduped: boolean };

/** @internal What an inbound webhook request carries. */
export interface WebhookDelivery {
  tenantId: string;
  workflowId: string;
  slug: string;
  headers: Headers;
  body: Uint8Array;
}

/** One `emit` match that could not start a run: reported, never thrown. */
export interface EmitRejection {
  /** The workflow whose trigger rejected the delivery. */
  workflowId: string;
  /** Its published version. */
  version: number;
  /** Why, e.g. `Event "deal.updated" for workflow "deal-won": field "deal.amount" expected number`. */
  message: string;
  /** The validation issues (`code: "config.invalid"` for payload problems). */
  issues: Issue[];
}

/** The outcome of {@link Triggers.emit}. */
export interface EmitResult {
  /** IDs of the runs this call started, in workflow ID order. */
  started: string[];
  /** Matches that could not start, in workflow ID order. Empty when everything started or deduped. */
  rejected: EmitRejection[];
}

/**
 * Call-site deduplication of `engine.emit` and `engine.start`: deliveries with the same `key`
 * start one run within `window`.
 */
export interface DedupeOptions {
  /**
   * Key identifying duplicate deliveries (e.g. an outbox event ID); `""` → no key. Namespaced
   * per workflow by the engine. For `emit`, a trigger's own `dedupe.key` beats it.
   */
  key?: string;
  /**
   * How long the key suppresses duplicates: whole ms, or a duration such as `"30m"` or `"2d"`,
   * from 1 ms to 365 days. Beats the trigger's `dedupe.window` and the engine's
   * `dedupe.defaultWindow`.
   */
  window?: DurationInput;
}

/** @internal The trigger side of the engine. */
export interface Triggers {
  emit(
    event: string,
    payload: unknown,
    opts: { tenantId: string; dedupe?: DedupeOptions },
  ): Promise<EmitResult>;
  start(opts: {
    tenantId: string;
    workflowId: string;
    input?: unknown;
    dedupe?: DedupeOptions;
    startedBy?: RunOrigin;
  }): Promise<string>;
  tickSchedules(): Promise<number>;
  /** Poll every due poll workflow once (spec §7.2), leasing as `workerId`; resolves runs started. */
  tickPolls(workerId: string): Promise<number>;
  receiveWebhook(d: WebhookDelivery): Promise<WebhookResult>;
}

/** Defaults of `EngineOptions.poll`. */
const POLL_DEFAULTS = {
  defaultInterval: "1m",
  defaultMaxInterval: "24h",
  maxCallsPerTick: 10,
  leaseMs: 60_000,
} as const;

/** `EngineOptions.poll` resolved to ms. */
interface PollSettings {
  intervalMs: number;
  maxIntervalMs: number;
  maxCallsPerTick: number;
  leaseMs: number;
}

/** When a version's workflow was last published, or `null`/`undefined` when unknown. */
type PublishedAtLookup = (v: WorkflowVersion) => Promise<number | null | undefined>;

/** Thrown into a poll whose lease was lost; its result is discarded. */
class PollLeaseLostError extends Error {
  override readonly name = "PollLeaseLostError";
}

/**
 * `EngineOptions.poll` resolved to ms.
 *
 * @throws `FlowlineDefinitionError` for an invalid duration, `defaultMaxInterval <
 * defaultInterval`, a `maxCallsPerTick` that is not a positive integer, or a `leaseMs` that is not
 * a positive number.
 */
function pollSettings(opts: EngineCore["opts"]["poll"] = {}): PollSettings {
  const duration = (what: "defaultInterval" | "defaultMaxInterval"): number => {
    try {
      return parseWindow(opts[what] ?? POLL_DEFAULTS[what], 0, `poll.${what}`);
    } catch (err) {
      throw new FlowlineDefinitionError(`EngineOptions.${errorMessage(err)}`);
    }
  };
  const intervalMs = duration("defaultInterval");
  const maxIntervalMs = duration("defaultMaxInterval");
  if (maxIntervalMs < intervalMs) {
    throw new FlowlineDefinitionError(
      `EngineOptions.poll.defaultMaxInterval (${maxIntervalMs} ms) is shorter than poll.defaultInterval (${intervalMs} ms)`,
    );
  }
  const maxCallsPerTick = opts.maxCallsPerTick ?? POLL_DEFAULTS.maxCallsPerTick;
  if (!Number.isInteger(maxCallsPerTick) || maxCallsPerTick < 1) {
    throw new FlowlineDefinitionError(
      `EngineOptions.poll.maxCallsPerTick must be a positive integer, got ${maxCallsPerTick}`,
    );
  }
  const leaseMs = opts.leaseMs ?? POLL_DEFAULTS.leaseMs;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new FlowlineDefinitionError(
      `EngineOptions.poll.leaseMs must be a positive number, got ${leaseMs}`,
    );
  }
  return { intervalMs, maxIntervalMs, maxCallsPerTick, leaseMs };
}

/** A namespaced dedupe key and how long it suppresses duplicates. */
interface LaunchDedupe {
  key: string;
  windowMs: number;
}

/** A non-empty key, else `undefined` (an empty key means no dedupe). */
const nonEmpty = (key: string | undefined): string | undefined =>
  key === undefined || key === "" ? undefined : key;

/**
 * @internal Create the trigger functions of an engine.
 *
 * @throws `FlowlineDefinitionError` if `EngineOptions.dedupe.defaultWindow` is invalid.
 */
export function createTriggers(core: EngineCore): Triggers {
  const { storage, registry, clock } = core;
  let defaultWindowMs: number;
  try {
    defaultWindowMs = parseWindow(core.opts.dedupe?.defaultWindow ?? DEFAULT_DEDUPE_WINDOW, 0);
  } catch (err) {
    throw new FlowlineDefinitionError(`EngineOptions.dedupe.defaultWindow: ${errorMessage(err)}`);
  }
  const polls = pollSettings(core.opts.poll);

  /**
   * A poll trigger's effective `interval` and `maxInterval` in ms, engine defaults applied (an
   * undeclared `maxInterval` is never below the trigger's `interval`).
   *
   * @throws `FlowlineDefinitionError` if a duration is invalid or the effective `maxInterval` is
   * shorter than the effective `interval` (e.g. `maxInterval: "30s"` with the default `"1m"`).
   */
  // biome-ignore lint/suspicious/noExplicitAny: definitions of any config/payload types
  const pollTiming = (def: TriggerDefinition<any, any>) => {
    let intervalMs: number;
    let maxIntervalMs: number;
    try {
      intervalMs = parseWindow(def.interval, polls.intervalMs, "Poll interval");
      maxIntervalMs =
        def.maxInterval === undefined
          ? Math.max(polls.maxIntervalMs, intervalMs)
          : parseWindow(def.maxInterval, 0, "Poll maxInterval");
    } catch (err) {
      throw new FlowlineDefinitionError(`Trigger "${def.type}": ${errorMessage(err)}`);
    }
    if (maxIntervalMs < intervalMs) {
      throw new FlowlineDefinitionError(
        `Trigger "${def.type}" has an effective maxInterval (${maxIntervalMs} ms) shorter than its effective interval (${intervalMs} ms, engine defaults applied)`,
      );
    }
    return { intervalMs, maxIntervalMs };
  };
  // Check every registered poll trigger against the engine defaults now, at startup.
  for (const plugin of registry.plugins) {
    for (const def of plugin.triggers ?? []) if (def.kind === "poll") pollTiming(def);
  }

  /**
   * Create a queued run of `v` with its `run.started` event (spec §4.2). With `dedupe`, a
   * delivery that loses the claim starts nothing (recreating the claimant's run if it is missing)
   * and reports `trigger.deduped`. `created` is whether this call started the run: true exactly
   * for the claimant, or for every call without `dedupe`.
   */
  const launch = async (
    v: WorkflowVersion,
    trigger: unknown,
    startedBy: RunOrigin,
    dedupe?: LaunchDedupe,
  ): Promise<{ runId: string; created: boolean }> => {
    const now = clock();
    let runId = `run_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
    let claimed = true;
    if (dedupe !== undefined) {
      const claim = await storage.claimDedupeKey(
        v.tenantId,
        dedupe.key,
        runId,
        now,
        dedupe.windowMs,
      );
      claimed = claim.claimed;
      runId = claim.runId;
      if (claimed) await core.opts.__testHooks?.afterDedupeClaim?.(v.tenantId, dedupe.key, runId);
      // A claim held by an earlier delivery whose run exists is a duplicate. One whose run is
      // missing lost it to a crash right after the key was claimed (or to a concurrent claimant
      // that hasn't inserted it yet): create it now (`createRun` is idempotent on the id).
      if (!claimed && (await storage.getRun(v.tenantId, runId))) {
        reportDeduped(v, runId, dedupe.key, startedBy, now);
        return { runId, created: false };
      }
    }
    const events = [core.event({ id: runId, tenantId: v.tenantId }, "run.started", undefined)];
    const run = await storage.createRun(
      {
        id: runId,
        tenantId: v.tenantId,
        workflowId: v.workflowId,
        version: v.version,
        status: "queued",
        trigger,
        journal: {},
        attempt: 1,
        startedBy,
      },
      events,
      now,
    );
    // Exactly the delivery that claimed the key (or the only delivery, without one) counts as
    // creating the run, even if a concurrent loser inserted it first: run IDs are random, so the
    // run under a claimed ID is always this delivery's. A loser that inserted it (recovering a
    // crash, or racing ahead of the claimant) is answered and reported as a duplicate, and its
    // `run.started` never reaches `onEvent`; the run executes normally.
    if (dedupe !== undefined && !claimed) {
      reportDeduped(v, runId, dedupe.key, startedBy, now);
      return { runId, created: false };
    }
    const created = run.workflowId === v.workflowId;
    if (created) core.publish(await storedStart(run, now, events));
    return { runId, created };
  };

  /**
   * The `run.started` to publish for `run`: `own` when this delivery inserted it (`createdAt ===
   * now`), else the stored one a concurrent loser inserted (so `onEvent` sees what storage holds).
   */
  const storedStart = async (
    run: { id: string; tenantId: string; createdAt: number },
    now: number,
    own: NewRunEvent[],
  ): Promise<NewRunEvent[]> => {
    if (run.createdAt === now) return own;
    const stored = (await storage.listEvents(run.tenantId, run.id)).find(
      (e) => e.type === "run.started",
    );
    return stored ? [stored] : own;
  };

  /** Report a delivery suppressed because `key` already belongs to run `runId`. */
  const reportDeduped = (
    v: WorkflowVersion,
    runId: string,
    key: string,
    source: RunOrigin,
    at: number,
  ): void => {
    core.triggerEvent({
      type: "trigger.deduped",
      at,
      tenantId: v.tenantId,
      workflowId: v.workflowId,
      runId,
      key,
      source,
    });
  };

  /** `input` checked against `v`'s trigger; throws a {@link FlowlineValidationError} if invalid. */
  const payloadFor = async (v: WorkflowVersion, input: unknown, what: string) => {
    const checked = await checkTriggerPayload(registry, v.doc, input);
    if (!checked.ok) {
      const message = `${what} for workflow "${v.workflowId}": ${checked.message}`;
      throw new FlowlineValidationError(message, [payloadIssue(message)]);
    }
    return checked.value;
  };

  /** The trigger definition and parsed config of `v`, or `undefined` when unusable. */
  const triggerOf = (v: WorkflowVersion) => {
    const def = registry.getTrigger(v.doc.trigger.type);
    if (!def) return undefined;
    const parsed = def.config.safeParse(visibleTriggerConfig(registry, v.doc));
    if (!parsed.success) {
      core.logger?.warn("skipping workflow with invalid trigger config", {
        tenantId: v.tenantId,
        workflowId: v.workflowId,
        error: parsed.error.issues[0]?.message,
      });
      return undefined;
    }
    return { def, config: parsed.data as Record<string, unknown> };
  };

  /**
   * The dedupe of one delivery: `key` namespaced as `<namespace>:<workflowId>:<key>`, and the
   * window `callWindowMs` (already parsed), else the trigger's `dedupe.window`, else the engine
   * default. No key → `undefined`.
   */
  const dedupeFor = (
    namespace: string,
    v: WorkflowVersion,
    key: string | undefined,
    callWindowMs: number | undefined,
  ): LaunchDedupe | undefined => {
    if (key === undefined) return undefined;
    const triggerWindow = registry.getTrigger(v.doc.trigger.type)?.dedupe?.window;
    return {
      key: `${namespace}:${v.workflowId}:${key}`,
      windowMs: callWindowMs ?? parseWindow(triggerWindow, defaultWindowMs),
    };
  };

  /** A call-site window in ms (`undefined` when not given); throws if invalid. */
  const callWindowOf = (window: DurationInput | undefined): number | undefined =>
    window === undefined ? undefined : parseWindow(window, defaultWindowMs);

  /**
   * A lookup of when a version's workflow was last published (`null`/`undefined` when unknown),
   * listing each tenant's workflows at most once. Make one per tick: it never refreshes.
   */
  const publishedAtCache = (): PublishedAtLookup => {
    const byTenant = new Map<string, Map<string, number | null>>();
    return async (v) => {
      let byWorkflow = byTenant.get(v.tenantId);
      if (!byWorkflow) {
        const list = await storage.listWorkflows(v.tenantId);
        byWorkflow = new Map(list.map((w) => [w.id, w.publishedAt]));
        byTenant.set(v.tenantId, byWorkflow);
      }
      return byWorkflow.get(v.workflowId);
    };
  };

  /**
   * Validate and launch the items of one poll call over `(since, until]`, in array order. An
   * item with an empty key, an invalid payload or a failed launch is rejected (`trigger.rejected`)
   * without affecting the others; a repeated key dedupes (`trigger.deduped`). Stops early once
   * `signal` aborts (the lease was lost). `onStarted` is called for each run started.
   */
  const launchPollItems = async (
    v: WorkflowVersion,
    items: unknown[],
    interval: { since: number; until: number; windowMs: number },
    signal: AbortSignal,
    onStarted: () => void,
  ): Promise<{ started: number; rejected: number }> => {
    let started = 0;
    let rejected = 0;
    for (const raw of items) {
      if (signal.aborted) break;
      const entry = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
      const itemKey = typeof entry.key === "string" ? entry.key : "";
      const reject = (message: string, issues: Issue[]) => {
        rejected++;
        core.triggerEvent({
          type: "trigger.rejected",
          at: clock(),
          tenantId: v.tenantId,
          workflowId: v.workflowId,
          version: v.version,
          source: { kind: "poll", itemKey },
          message,
          issues,
        });
      };
      if (itemKey === "") {
        reject("item key is empty", [payloadIssue("item key is empty")]);
        continue;
      }
      let payload: unknown;
      try {
        payload = await payloadFor(v, entry.payload, `Poll item "${itemKey}"`);
      } catch (err) {
        const message = errorMessage(err);
        reject(
          message,
          err instanceof FlowlineValidationError ? err.issues : [payloadIssue(message)],
        );
        continue;
      }
      try {
        const r = await launch(
          v,
          payload,
          { kind: "poll", since: interval.since, until: interval.until, itemKey },
          { key: `poll:${v.workflowId}:${itemKey}`, windowMs: interval.windowMs },
        );
        if (r.created) {
          started++;
          onStarted();
        }
      } catch (err) {
        reject(errorMessage(err), []);
      }
    }
    return { started, rejected };
  };

  /**
   * Poll workflow `v` once (spec §7.2): claim its poll state, then call the trigger's `poll` over
   * contiguous chunks `(since, until]` of at most `maxInterval`, launching each chunk's items and
   * committing its advance (keeping the lease between chunks), until caught up with the clock or
   * `maxCallsPerTick` calls were made. A throwing poll, an invalid result or a lost lease commits
   * `nextAt = now + interval` with `lastError`, without advancing `since`/`cursor`, and publishes
   * `poll.failed`. `onStarted` is called for each run started. A workflow with no publish time is
   * skipped (as by `tickSchedules`); nothing is claimed.
   */
  const pollWorkflow = async (
    v: WorkflowVersion,
    workerId: string,
    publishedAtOf: PublishedAtLookup,
    onStarted: () => void,
  ): Promise<void> => {
    const t = triggerOf(v);
    if (!t || typeof t.def.poll !== "function") return;
    const poll = t.def.poll.bind(t.def);
    // Resolve everything that can throw before claiming, so a bad definition never holds a lease.
    const { intervalMs, maxIntervalMs } = pollTiming(t.def);
    const windowMs = parseWindow(t.def.dedupe?.window, defaultWindowMs);
    const publishedAt = await publishedAtOf(v);
    if (publishedAt === undefined || publishedAt === null) return;
    const { tenantId, workflowId } = v;
    const lease = await storage.claimPoll(tenantId, workflowId, {
      workerId,
      leaseMs: polls.leaseMs,
      now: clock(),
    });
    if (!lease) return;

    // One lease covers the whole chain; renewing it every `leaseMs / 2` keeps a slow poll (or a
    // long catch-up) exclusive. Losing it aborts `ctx.signal` and discards the call in flight.
    // Each renewal is scheduled only once the previous one settled, so slow storage never piles
    // renewals up.
    const controller = new AbortController();
    const lose = (reason: string) => controller.abort(new PollLeaseLostError(reason));
    let finished = false;
    let renewal: ReturnType<typeof setTimeout> | undefined;
    const scheduleRenewal = () => {
      renewal = setTimeout(() => {
        storage.renewPollLease(lease, polls.leaseMs, clock()).then(
          (ok) => {
            if (!ok) lose("poll lease lost");
            else if (!finished) scheduleRenewal();
          },
          (err: unknown) => lose(`poll lease renewal failed: ${errorMessage(err)}`),
        );
      }, polls.leaseMs / 2);
    };
    scheduleRenewal();
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
        once: true,
      });
    });
    // The losing side of the race must not surface as an unhandled rejection.
    aborted.catch(() => {});

    try {
      let since = lease.state.since ?? publishedAt;
      let cursor: unknown = lease.state.cursor ?? null;
      for (let calls = 1; ; calls++) {
        const now = clock();
        // A clock behind `since` (a host bug): poll nothing and leave the state as it is, so the
        // next interval starts exactly at `since` once the clock passes it. `since` is written
        // too (never an advance: it is the stored value or the first publish time), pinning the
        // first interval's start so a later republish can't move it forward.
        if (now <= since) {
          await storage.commitPoll(lease, { since, nextAt: since + intervalMs }, now);
          return;
        }
        const until = Math.min(now, since + maxIntervalMs);
        const interval = { since, until };
        /** Publish `poll.failed`; `nextAt` only when it was written (the lease was still ours). */
        const reportFailed = (message: string, nextAt?: number) =>
          core.triggerEvent({
            type: "poll.failed",
            at: clock(),
            tenantId,
            workflowId,
            ...interval,
            message,
            ...(nextAt === undefined ? {} : { nextAt }),
          });
        const fail = async (err: unknown) => {
          const message = errorMessage(err);
          const nextAt = now + intervalMs;
          let written = false;
          try {
            // `since` pins the first interval's start (see above); `false` when the lease was
            // lost: the new holder owns the state now.
            written = await storage.commitPoll(
              lease,
              { since, nextAt, lastError: message },
              clock(),
            );
          } catch (commitErr) {
            core.logger?.warn("poll failure commit failed", {
              tenantId,
              workflowId,
              error: errorMessage(commitErr),
            });
          }
          reportFailed(message, written ? nextAt : undefined);
        };

        let result: { items: unknown[]; cursor?: unknown };
        try {
          if (controller.signal.aborted) throw controller.signal.reason;
          const ctx: PollContext = {
            tenantId,
            workflowId,
            services: core.opts.services ?? ({} as FlowlineServices),
            ...(core.logger ? { logger: core.logger } : {}),
            signal: controller.signal,
          };
          const call = Promise.resolve().then(() =>
            poll({ config: t.config, since, until, cursor, ctx }),
          );
          call.catch(() => {});
          const returned: unknown = await Promise.race([call, aborted]);
          if (
            typeof returned !== "object" ||
            returned === null ||
            !Array.isArray((returned as { items?: unknown }).items)
          ) {
            throw new Error("poll must return { items: [...] }");
          }
          result = returned as { items: unknown[]; cursor?: unknown };
        } catch (err) {
          await fail(err);
          return;
        }

        const counts = await launchPollItems(
          v,
          result.items,
          { ...interval, windowMs },
          controller.signal,
          onStarted,
        );
        if (controller.signal.aborted) {
          // Launched items dedupe when the new holder polls this interval again.
          await fail(controller.signal.reason);
          return;
        }

        // Catch up while the call was capped by `maxInterval` and calls remain in this tick.
        const behind = until < now;
        const more = behind && calls < polls.maxCallsPerTick;
        const nextCursor = result.cursor ?? null;
        const patch: PollPatch = {
          since: until,
          cursor: nextCursor,
          nextAt: behind ? now : until + intervalMs,
          lastError: null,
          ...(more ? { keepLease: true } : {}),
        };
        await core.opts.__testHooks?.beforeCommitPoll?.(tenantId, workflowId);
        let committed: boolean;
        try {
          committed = await storage.commitPoll(lease, patch, clock());
        } catch (err) {
          // E.g. a cursor that isn't JSON: like a throwing poll, the interval is polled again.
          await fail(err);
          return;
        }
        if (!committed) {
          // The new holder polls this interval again; launched items dedupe. `reportFailed`
          // publishes `poll.failed`, which `publishTriggerEvent` already logs at `warn`.
          reportFailed("poll lease lost");
          return;
        }
        core.triggerEvent({
          type: "poll.completed",
          at: clock(),
          tenantId,
          workflowId,
          ...interval,
          items: result.items.length,
          ...counts,
        });
        if (!more) return;
        since = until;
        cursor = nextCursor;
      }
    } finally {
      finished = true;
      clearTimeout(renewal);
    }
  };

  return {
    async emit(event, payload, { tenantId, dedupe }) {
      // An invalid call-site window is the caller's mistake, not one match's: throw before any
      // match starts.
      const callWindowMs = callWindowOf(dedupe?.window);
      const callKey = nonEmpty(dedupe?.key);
      const versions = (await storage.listPublished({ tenantId }))
        .filter((v) => {
          const def = registry.getTrigger(v.doc.trigger.type);
          if (def?.kind !== "event") return false;
          if (def.event !== undefined) return def.event === event;
          if (def.events !== undefined) return def.events.includes(event);
          // core.event: the event name is configured, not declared on the trigger definition.
          return visibleTriggerConfig(registry, v.doc).event === event;
        })
        .sort((a, b) => (a.workflowId < b.workflowId ? -1 : 1));

      const started: string[] = [];
      const rejected: EmitRejection[] = [];

      /**
       * Report `err` as one workflow's rejected delivery: never throws, never starts a run.
       * `issues` defaults to the validation error's issues, else one `config.invalid` issue.
       */
      const reject = (v: WorkflowVersion, err: unknown, withIssues?: Issue[]): void => {
        const message = err instanceof FlowlineValidationError ? err.message : errorMessage(err);
        const issues =
          withIssues ??
          (err instanceof FlowlineValidationError ? err.issues : [payloadIssue(message)]);
        rejected.push({ workflowId: v.workflowId, version: v.version, message, issues });
        core.triggerEvent({
          type: "trigger.rejected",
          at: clock(),
          tenantId,
          workflowId: v.workflowId,
          version: v.version,
          source: { kind: "event", event },
          message,
          issues,
        });
      };

      for (const v of versions) {
        // A trigger config that no longer parses is skipped (warned above), not rejected: it isn't
        // a delivery problem.
        const t = triggerOf(v);
        if (!t) continue;

        // Spec §5's pipeline: normalize -> validate -> filter -> key. `normalize` runs before
        // payload validation so it can reshape one source's raw event into this trigger's
        // payload shape; returning `undefined` skips the delivery (not a rejection).
        let raw = payload;
        if (t.def.normalize !== undefined) {
          try {
            const normalized = t.def.normalize(event, payload);
            if (normalized === undefined) continue;
            raw = normalized;
          } catch (err) {
            reject(v, new Error(`normalize threw: ${errorMessage(err)}`));
            continue;
          }
        }

        let value: unknown;
        try {
          value = await payloadFor(v, raw, `Event "${event}"`);
        } catch (err) {
          reject(v, err);
          continue;
        }

        let skip = false;
        try {
          skip =
            t.def.filter !== undefined &&
            !t.def.filter({ config: t.config, payload: value, event });
        } catch (err) {
          reject(v, new Error(`filter threw: ${errorMessage(err)}`));
          continue;
        }
        if (skip) continue;

        // The trigger's key (domain identity, e.g. a booking ID) beats the call site's (typically
        // a delivery ID, only meaningful for retries).
        let key: string | undefined;
        let launchDedupe: LaunchDedupe | undefined;
        try {
          key = nonEmpty(t.def.dedupe?.key({ config: t.config, payload: value, event }));
        } catch (err) {
          reject(v, new Error(`dedupe.key threw: ${errorMessage(err)}`));
          continue;
        }
        try {
          launchDedupe = dedupeFor("event", v, key ?? callKey, callWindowMs);
        } catch (err) {
          reject(v, err); // an invalid window on a trigger defined without `defineTrigger`
          continue;
        }

        // Spec §3.2: any step that throws, launching included (a storage error, say), rejects
        // this match only. The host sees it in `rejected`; with a dedupe key, re-emitting is
        // safe: matches that started are deduped, and this one gets another chance.
        try {
          const r = await launch(v, value, { kind: "event", event }, launchDedupe);
          if (r.created) started.push(r.runId);
        } catch (err) {
          reject(v, err, []);
        }
      }
      return { started, rejected };
    },

    async start({ tenantId, workflowId, input, dedupe, startedBy }) {
      const callWindowMs = callWindowOf(dedupe?.window);
      const v = await storage.getPublishedVersion(tenantId, workflowId);
      if (!v) throw new Error(`Workflow "${workflowId}" is not published`);
      const payload = await payloadFor(v, input ?? {}, "Input");
      const launchDedupe = dedupeFor("start", v, nonEmpty(dedupe?.key), callWindowMs);
      const r = await launch(v, payload, startedBy ?? { kind: "manual" }, launchDedupe);
      return r.runId;
    },

    async tickSchedules() {
      const now = clock();
      const due = (await storage.listPublished({})).filter(
        (v) => registry.getTrigger(v.doc.trigger.type)?.kind === "schedule",
      );
      const publishedAtOf = publishedAtCache();
      let started = 0;
      for (const v of due) {
        try {
          const t = triggerOf(v);
          const cron = t?.config.cron;
          if (typeof cron !== "string") continue;
          const tz = typeof t?.config.timezone === "string" ? t.config.timezone : "UTC";
          // `prev()` is strictly before `currentDate`: +1 ms makes a fire at exactly `now` due.
          const fireAt = CronExpressionParser.parse(cron, { currentDate: new Date(now + 1), tz })
            .prev()
            .getTime();
          const since = await publishedAtOf(v);
          if (since === undefined || since === null || fireAt < since) continue;
          const r = await launch(
            v,
            { firedAt: new Date(fireAt).toISOString() },
            { kind: "schedule", fireAt },
            { key: `schedule:${v.workflowId}:${fireAt}`, windowMs: defaultWindowMs },
          );
          if (r.created) started++;
        } catch (err) {
          core.logger?.warn("schedule tick failed", {
            tenantId: v.tenantId,
            workflowId: v.workflowId,
            error: errorMessage(err),
          });
        }
      }
      return started;
    },

    async tickPolls(workerId) {
      const polled = (await storage.listPublished({})).filter(
        (v) => registry.getTrigger(v.doc.trigger.type)?.kind === "poll",
      );
      const publishedAtOf = publishedAtCache();
      let started = 0;
      for (const v of polled) {
        try {
          await pollWorkflow(v, workerId, publishedAtOf, () => started++);
        } catch (err) {
          core.logger?.warn("poll tick failed", {
            tenantId: v.tenantId,
            workflowId: v.workflowId,
            error: errorMessage(err),
          });
        }
      }
      return started;
    },

    async receiveWebhook(d) {
      const v = await storage.getPublishedVersion(d.tenantId, d.workflowId);
      if (!v || registry.getTrigger(v.doc.trigger.type)?.kind !== "webhook") {
        return { status: "notFound" };
      }
      const visible = visibleTriggerConfig(registry, v.doc);
      const slug = configString(visible, "slug");
      // A wrong slug looks exactly like a missing workflow.
      if (slug === undefined || !safeEqual(slug, d.slug)) return { status: "notFound" };

      const secretName = configString(visible, "secret");
      const rawSecret = visible.secret;
      // A signing secret that isn't a literal name (e.g. a reference) fails closed.
      if (secretName === undefined && rawSecret !== undefined && rawSecret !== "") {
        core.logger?.warn("webhook signing secret is not a secret name", {
          workflowId: d.workflowId,
        });
        return { status: "unauthorized" };
      }
      if (secretName !== undefined) {
        const key = await core.opts.secrets?.get(d.tenantId, secretName);
        const match = /^sha256=([0-9a-f]{64})$/i.exec(d.headers.get("x-flowline-signature") ?? "");
        if (key === undefined) {
          core.logger?.warn("webhook signing secret is not configured", {
            workflowId: d.workflowId,
            secret: secretName,
          });
        }
        if (key === undefined || !match) return { status: "unauthorized" };
        const expected = createHmac("sha256", key).update(d.body).digest();
        const given = Buffer.from(match[1] as string, "hex");
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
          return { status: "unauthorized" };
        }
      }

      let body: unknown = {};
      const text = new TextDecoder().decode(d.body);
      if (text.trim() !== "") {
        try {
          body = JSON.parse(text);
        } catch {
          const message = "Body is not valid JSON";
          return { status: "invalid", message, issues: [payloadIssue(message)] };
        }
      }
      const headers: Record<string, string> = {};
      d.headers.forEach((value, name) => {
        const lower = name.toLowerCase();
        if (keptHeader(lower)) headers[lower] = value;
      });
      let payload: unknown;
      try {
        payload = await payloadFor(v, { body, headers }, "Webhook body");
      } catch (err) {
        if (err instanceof FlowlineValidationError) {
          return { status: "invalid", message: err.message, issues: err.issues };
        }
        throw err;
      }
      const t = triggerOf(v);
      if (!t) return { status: "notFound" };
      // A throwing filter or dedupe.key, or a storage error, propagates (500), so the sender
      // retries the delivery.
      if (t.def.filter && !t.def.filter({ config: t.config, payload }))
        return { status: "skipped" };
      // The dedupe header's value (with `dedupeWindow`) beats the trigger's key.
      const dedupeHeader = configString(visible, "dedupeHeader");
      const headerKey = nonEmpty(
        (dedupeHeader === undefined ? null : d.headers.get(dedupeHeader)) ?? undefined,
      );
      const launchDedupe =
        headerKey !== undefined
          ? dedupeFor("webhook", v, headerKey, callWindowOf(configString(visible, "dedupeWindow")))
          : dedupeFor(
              "webhook",
              v,
              nonEmpty(t.def.dedupe?.key({ config: t.config, payload })),
              undefined,
            );
      const r = await launch(v, payload, { kind: "webhook" }, launchDedupe);
      return { status: "started", runId: r.runId, deduped: !r.created };
    },
  };
}
