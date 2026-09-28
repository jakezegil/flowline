/**
 * Starting runs: `engine.emit` (event triggers), `engine.start` (manual/code), inbound webhooks
 * and cron schedules (`engine.tickSchedules`).
 *
 * Deduplication: a start with a dedupe key records the key (`recordDedupeKey`) and derives the run
 * id from it, so of any number of deliveries (concurrent ones, or in several processes) exactly one
 * starts a run, and a delivery retried after a crash between the two writes still creates it.
 *
 * @module
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Issue, RunOrigin, WorkflowVersion } from "@flowkit/core";
import { CronExpressionParser } from "cron-parser";
import { sha256Hex } from "./context";
import type { EngineCore } from "./engine";
import { FlowkitValidationError } from "./errors";
import { checkTriggerPayload, visibleTriggerConfig } from "./subflow";
import { errorMessage } from "./util";

/** How long dedupe keys are recorded. Run ids derived from a key keep deduplicating after it. */
const DEDUPE_TTL_MS = 7 * 24 * 3_600_000;

/** Request headers never stored in a webhook run's `trigger.headers`. */
const DROPPED_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "x-flowkit-signature",
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

/** @internal The trigger side of the engine. */
export interface Triggers {
  emit(
    event: string,
    payload: unknown,
    opts: { tenantId: string; dedupeKey?: string },
  ): Promise<string[]>;
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
   * the key was seen before. `created` is whether this call started the run.
   */
  const launch = async (
    v: WorkflowVersion,
    trigger: unknown,
    startedBy: RunOrigin,
    dedupeKey?: string,
  ): Promise<{ runId: string; created: boolean }> => {
    const now = clock();
    let runId: string;
    let fresh = true;
    if (dedupeKey === undefined) {
      runId = `run_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
    } else {
      fresh = await storage.recordDedupeKey(v.tenantId, dedupeKey, now, DEDUPE_TTL_MS);
      runId = `run_${(await sha256Hex(`${v.tenantId}\u0000${dedupeKey}`)).slice(0, 32)}`;
    }
    // A seen key whose run exists is a duplicate. One whose run is missing lost it to a crash right
    // after the key was recorded: create it now (`createRun` is idempotent on the id).
    if (!fresh && (await storage.getRun(v.tenantId, runId))) return { runId, created: false };
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
    // Only the delivery that recorded the key counts as creating the run: a concurrent duplicate
    // can reach this point before that delivery's insert, and must not report or publish it too.
    // So a run recovered after a crash is created without its `run.started` reaching `onEvent`,
    // and its delivery is answered as a duplicate; the run itself executes normally.
    const created = fresh && run.createdAt === now && run.workflowId === v.workflowId;
    if (created) core.publish(events);
    return { runId, created };
  };

  /** `input` checked against `v`'s trigger; throws a {@link FlowkitValidationError} if invalid. */
  const payloadFor = async (v: WorkflowVersion, input: unknown, what: string) => {
    const checked = await checkTriggerPayload(registry, v.doc, input);
    if (!checked.ok) {
      const message = `${what} for workflow "${v.workflowId}": ${checked.message}`;
      throw new FlowkitValidationError(message, [payloadIssue(message)]);
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
      const matches: { v: WorkflowVersion; payload: unknown; key: string | undefined }[] = [];
      for (const v of await storage.listPublished({ tenantId })) {
        const def = registry.getTrigger(v.doc.trigger.type);
        if (def?.kind !== "event") continue;
        if ((def.event ?? visibleTriggerConfig(registry, v.doc).event) !== event) continue;
        const t = triggerOf(v);
        if (!t) continue;
        // Validation throws before any run is created.
        const value = await payloadFor(v, payload, `Event "${event}"`);
        let key = dedupeKey;
        try {
          if (t.def.filter && !t.def.filter({ config: t.config, payload: value })) continue;
          key ??= t.def.dedupeKey?.({ config: t.config, payload: value });
        } catch (err) {
          core.logger?.error("trigger filter or dedupeKey threw", {
            workflowId: v.workflowId,
            error: errorMessage(err),
          });
          continue;
        }
        matches.push({ v, payload: value, key });
      }
      matches.sort((a, b) => (a.v.workflowId < b.v.workflowId ? -1 : 1));
      const started: string[] = [];
      for (const m of matches) {
        const key = m.key === undefined ? undefined : `event:${m.v.workflowId}:${event}:${m.key}`;
        const r = await launch(m.v, m.payload, { kind: "event", event }, key);
        if (r.created) started.push(r.runId);
      }
      return started;
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
      if (secretName !== undefined) {
        const key = await core.opts.secrets?.get(d.tenantId, secretName);
        const match = /^sha256=([0-9a-f]{64})$/i.exec(d.headers.get("x-flowkit-signature") ?? "");
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
        if (err instanceof FlowkitValidationError) {
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
