/**
 * Starting runs: `engine.emit` (event triggers), `engine.start` (manual/code), inbound webhooks
 * and cron schedules (`engine.tickSchedules`).
 *
 * Deduplication: a start with a dedupe key generates a random run ID up front and atomically
 * claims the key for it (`claimDedupeKey`), so of any number of deliveries (concurrent ones, or in
 * several processes) exactly one starts a run, and a delivery retried after a crash between the
 * claim and the run's creation still creates it. A key claimed once suppresses duplicates only
 * until its window expires (see {@link DEDUPE_WINDOW_MS}); a delivery after that starts a new run
 * with a fresh ID.
 *
 * TODO(Task 3): this is the minimal switch to `claimDedupeKey`, keeping the engine compiling with a
 * fixed default window. The full precedence/window configuration protocol (§4.2-4.4 of the design
 * spec) lands separately.
 *
 * @module
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Issue, RunOrigin, WorkflowVersion } from "@flowlinejs/core";
import { CronExpressionParser } from "cron-parser";
import type { EngineCore } from "./engine";
import { FlowlineValidationError } from "./errors";
import { checkTriggerPayload, visibleTriggerConfig } from "./subflow";
import { errorMessage } from "./util";

/** Default dedupe window: how long a claimed key suppresses duplicate deliveries. */
const DEDUPE_WINDOW_MS = 7 * 24 * 3_600_000;

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

/** @internal The trigger side of the engine. */
export interface Triggers {
  emit(
    event: string,
    payload: unknown,
    opts: { tenantId: string; dedupeKey?: string },
  ): Promise<EmitResult>;
  start(opts: {
    tenantId: string;
    workflowId: string;
    input?: unknown;
    dedupeKey?: string;
    startedBy?: RunOrigin;
  }): Promise<string>;
  tickSchedules(): Promise<number>;
  receiveWebhook(d: WebhookDelivery): Promise<WebhookResult>;
}

/** @internal Create the trigger functions of an engine. */
export function createTriggers(core: EngineCore): Triggers {
  const { storage, registry, clock } = core;

  /**
   * Create a queued run of `v` with its `run.started` event. With a dedupe key, starts nothing if
   * the key is still claimed by an earlier delivery. `created` is whether this call started the
   * run.
   */
  const launch = async (
    v: WorkflowVersion,
    trigger: unknown,
    startedBy: RunOrigin,
    dedupeKey?: string,
  ): Promise<{ runId: string; created: boolean }> => {
    const now = clock();
    let runId = `run_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
    let claimed = true;
    if (dedupeKey !== undefined) {
      const claim = await storage.claimDedupeKey(
        v.tenantId,
        dedupeKey,
        runId,
        now,
        DEDUPE_WINDOW_MS,
      );
      claimed = claim.claimed;
      runId = claim.runId;
      // A claim held by an earlier delivery whose run exists is a duplicate. One whose run is
      // missing lost it to a crash right after the key was claimed: create it now (`createRun` is
      // idempotent on the id).
      if (!claimed && (await storage.getRun(v.tenantId, runId))) return { runId, created: false };
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
    // Only the delivery that claimed the key counts as creating the run: a concurrent duplicate
    // can reach this point before that delivery's insert, and must not report or publish it too.
    // So a run recovered after a crash is created without its `run.started` reaching `onEvent`,
    // and its delivery is answered as a duplicate; the run itself executes normally.
    const created = claimed && run.createdAt === now && run.workflowId === v.workflowId;
    if (created) core.publish(events);
    return { runId, created };
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

  return {
    async emit(event, payload, { tenantId, dedupeKey }) {
      const versions = (await storage.listPublished({ tenantId }))
        .filter((v) => {
          const def = registry.getTrigger(v.doc.trigger.type);
          if (def?.kind !== "event") return false;
          return (def.event ?? visibleTriggerConfig(registry, v.doc).event) === event;
        })
        .sort((a, b) => (a.workflowId < b.workflowId ? -1 : 1));

      const started: string[] = [];
      const rejected: EmitRejection[] = [];

      /** Report `err` as one workflow's rejected delivery: never throws, never starts a run. */
      const reject = (v: WorkflowVersion, err: unknown): void => {
        const message = err instanceof FlowlineValidationError ? err.message : errorMessage(err);
        const issues =
          err instanceof FlowlineValidationError ? err.issues : [payloadIssue(message)];
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

        let value: unknown;
        try {
          value = await payloadFor(v, payload, `Event "${event}"`);
        } catch (err) {
          reject(v, err);
          continue;
        }

        let skip = false;
        try {
          skip = t.def.filter !== undefined && !t.def.filter({ config: t.config, payload: value });
        } catch (err) {
          reject(v, new Error(`filter threw: ${errorMessage(err)}`));
          continue;
        }
        if (skip) continue;

        let key = dedupeKey;
        try {
          key ??= t.def.dedupeKey?.({ config: t.config, payload: value });
        } catch (err) {
          reject(v, new Error(`dedupeKey threw: ${errorMessage(err)}`));
          continue;
        }

        const namespacedKey =
          key === undefined ? undefined : `event:${v.workflowId}:${event}:${key}`;
        const r = await launch(v, value, { kind: "event", event }, namespacedKey);
        if (r.created) started.push(r.runId);
      }
      return { started, rejected };
    },

    async start({ tenantId, workflowId, input, dedupeKey, startedBy }) {
      const v = await storage.getPublishedVersion(tenantId, workflowId);
      if (!v) throw new Error(`Workflow "${workflowId}" is not published`);
      const payload = await payloadFor(v, input ?? {}, "Input");
      const key = dedupeKey === undefined ? undefined : `start:${workflowId}:${dedupeKey}`;
      const r = await launch(v, payload, startedBy ?? { kind: "manual" }, key);
      return r.runId;
    },

    async tickSchedules() {
      const now = clock();
      const due = (await storage.listPublished({})).filter(
        (v) => registry.getTrigger(v.doc.trigger.type)?.kind === "schedule",
      );
      const publishedAt = new Map<string, Map<string, number | null>>();
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
          let byWorkflow = publishedAt.get(v.tenantId);
          if (!byWorkflow) {
            const list = await storage.listWorkflows(v.tenantId);
            byWorkflow = new Map(list.map((w) => [w.id, w.publishedAt]));
            publishedAt.set(v.tenantId, byWorkflow);
          }
          const since = byWorkflow.get(v.workflowId);
          if (since === undefined || since === null || fireAt < since) continue;
          const r = await launch(
            v,
            { firedAt: new Date(fireAt).toISOString() },
            { kind: "schedule", fireAt },
            `schedule:${v.workflowId}:${fireAt}`,
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
      // A throwing filter or dedupeKey propagates (500), so the sender retries the delivery.
      if (t.def.filter && !t.def.filter({ config: t.config, payload }))
        return { status: "skipped" };
      const dedupeHeader = configString(visible, "dedupeHeader");
      const dedupeValue =
        (dedupeHeader === undefined ? null : d.headers.get(dedupeHeader)) ||
        t.def.dedupeKey?.({ config: t.config, payload });
      const key = dedupeValue ? `webhook:${v.workflowId}:${dedupeValue}` : undefined;
      const r = await launch(v, payload, { kind: "webhook" }, key);
      return { status: "started", runId: r.runId, deduped: !r.created };
    },
  };
}
