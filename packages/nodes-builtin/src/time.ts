/**
 * Timing nodes: `core.delay` and `core.waitForCallback`.
 *
 * @module
 */
import {
  branch,
  type CallbackHandle,
  defineNode,
  FatalError,
  type NodeContext,
  RetryableError,
  suspend,
  ui,
} from "@flowkit/core";
import { z } from "zod";

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const DURATION = /^([1-9][0-9]*)([smhd])$/;
const DURATION_MESSAGE = "Use a whole number and a unit: 30s, 5m, 2h or 3d";

/** The longest duration `core.delay` and `core.waitForCallback` accept: 365 days. */
export const MAX_DURATION_MS = 365 * UNIT_MS.d;
const MAX_DURATION_MESSAGE = "Durations can be at most 365d";

/**
 * Milliseconds in a duration such as `"30s"`, `"5m"`, `"2h"` or `"3d"` (a positive whole number
 * followed by `s`, `m`, `h` or `d`), or `undefined` if `text` is not one. Doesn't apply
 * {@link MAX_DURATION_MS}.
 */
export function parseDuration(text: string): number | undefined {
  const match = DURATION.exec(text);
  if (!match) return undefined;
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

/** {@link parseDuration}, throwing a {@link FatalError} for a malformed or too long duration. */
function durationMs(text: string): number {
  const ms = parseDuration(text);
  if (ms === undefined) throw new FatalError(DURATION_MESSAGE);
  if (ms > MAX_DURATION_MS) throw new FatalError(MAX_DURATION_MESSAGE);
  return ms;
}

const duration = () =>
  z
    .string()
    .regex(DURATION, DURATION_MESSAGE)
    .refine((text) => (parseDuration(text) ?? 0) <= MAX_DURATION_MS, MAX_DURATION_MESSAGE);

/** Pauses the run for a duration or until a point in time, then continues. */
export const delayNode = defineNode({
  type: "core.delay",
  name: "Delay",
  description: "Pause the run for a while, or until a date and time, then continue.",
  icon: "timer",
  category: "Timing",
  summary: "Wait {{duration}}{{until}}",
  // `oneOfRequired` lets the validator report a missing or doubled choice; the refinement below
  // enforces the same rule at runtime.
  input: ui(
    z
      .object({
        duration: ui(duration(), { label: "Wait for", placeholder: "2d" })
          .describe("How long to wait, e.g. 30s, 5m, 2h or 3d.")
          .optional(),
        until: ui(z.iso.datetime({ offset: true }), {
          label: "Wait until",
          placeholder: "2026-01-31T09:00:00Z",
        })
          .describe("Continue at this date and time instead.")
          .optional(),
      })
      .superRefine((v, check) => {
        if (v.duration === undefined && v.until === undefined) {
          check.addIssue({
            code: "custom",
            message: "Set how long to wait, or the date and time to wait until",
          });
        } else if (v.duration !== undefined && v.until !== undefined) {
          check.addIssue({
            code: "custom",
            message: "Set how long to wait or the date and time to wait until, not both",
          });
        }
      }),
    { oneOfRequired: [["duration"], ["until"]] },
  ),
  output: z.object({
    resumedAt: z.iso.datetime().describe("When the run continued."),
  }),
  run: ({ input, ctx }) => {
    const resumedAt = () => ({ resumedAt: new Date(ctx.now()).toISOString() });
    if (ctx.resume?.kind === "timer") return resumedAt();
    const until =
      input.until !== undefined
        ? Date.parse(input.until)
        : ctx.now() + durationMs(input.duration ?? "");
    return until <= ctx.now() ? resumedAt() : suspend({ until });
  },
});

/** Time budget of the `notify` request, in ms. */
const NOTIFY_TIMEOUT_MS = 10_000;

/** SHA-256 hex digest of `text`, via Web Crypto. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Statuses worth retrying: the receiver may accept the same request later. */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/**
 * POSTs `{ resumeUrl, expiresAt, runId }` to `url` through the SSRF-guarded `ctx.http`, without
 * following redirects, with an `Idempotency-Key` of its own per resume URL
 * (`sha256(runId:stepPath:token)`). A network error, 5xx, 408 or 429 throws a
 * {@link RetryableError}; any other non-2xx, a redirect, or an error from the network guard (such
 * as a blocked address) throws a {@link FatalError}. Error messages never include the resume URL.
 */
async function sendNotify(
  url: string,
  callback: CallbackHandle,
  ctx: NodeContext,
  signal: AbortSignal,
): Promise<void> {
  const key = await sha256Hex(`${ctx.runId}:${ctx.stepPath}:${callback.token}`);
  let res: Response;
  try {
    res = await ctx.http.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({
        resumeUrl: callback.resumeUrl,
        expiresAt: callback.expiresAt,
        runId: ctx.runId,
      }),
      // The body carries the resume URL: never replay it to wherever a redirect points.
      redirect: "error",
      signal,
      timeoutMs: NOTIFY_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "FatalError") throw err;
    const reason =
      err instanceof Error
        ? err.cause instanceof Error
          ? err.cause.message
          : err.message
        : String(err);
    throw new RetryableError(`Notify request failed: ${reason}`);
  }
  if (res.ok) return;
  const message = `Notify request failed: HTTP ${res.status}`;
  throw isTransientStatus(res.status) ? new RetryableError(message) : new FatalError(message);
}

/**
 * Pauses the run until an external system calls the step's one-time resume URL (taking the
 * `resumed` branch with the request body) or the timeout passes (taking `timeout`).
 *
 * The resume URL holds a secret token, so it is never journaled or put into events. To hand it to
 * another system, set `notify.url`: once the suspension is committed (the token is stored, so the
 * URL works) the engine POSTs `{ resumeUrl, expiresAt, runId }` as JSON there through `ctx.http`
 * (SSRF-guarded, redirects refused), with an `Idempotency-Key` unique to that resume URL.
 * Delivery is best effort and at most once per suspension: network errors, 5xx, 408 and 429 are
 * retried a few times inline; after that, or on any other failure, the run records a
 * `step.afterCommitFailed` event and keeps waiting (resumable through `engine.resumeRun` or ending at
 * the timeout). A worker crash between the commit and the POST skips the notification. Without
 * `notify`, the run resumes through `engine.resumeRun` (the run API or UI) only.
 */
export const waitForCallbackNode = defineNode({
  type: "core.waitForCallback",
  name: "Wait for callback",
  description:
    "Pause until another system calls this step's one-time resume URL, or until the timeout passes.",
  icon: "hourglass",
  category: "Timing",
  summary: "Wait for a callback",
  input: z.object({
    timeout: ui(duration(), { label: "Time out after", placeholder: "7d" })
      .describe("Take the Timed out path if no callback arrives in time, e.g. 2h or 7d.")
      .default("7d"),
    notify: ui(
      z.object({
        url: ui(z.url({ protocol: /^https?$/ }), {
          label: "URL",
          placeholder: "https://hooks.example.com/approvals",
        }).describe("Receives a POST with the resume URL, its expiry and the run ID."),
      }),
      { label: "Notify" },
    )
      .describe("Send the one-time resume URL to another system when the wait starts.")
      .optional(),
  }),
  output: z.object({
    body: z.unknown().describe("The body the callback was called with."),
    timedOut: z.boolean().describe("Whether the wait ended without a callback."),
  }),
  branches: {
    kind: "static",
    branches: [
      { id: "resumed", label: "Resumed" },
      { id: "timeout", label: "Timed out" },
    ],
  },
  run: async ({ input, ctx }) => {
    if (ctx.resume?.kind === "callback") {
      return branch("resumed", { body: ctx.resume.body ?? null, timedOut: false });
    }
    if (ctx.resume?.kind === "timeout") {
      return branch("timeout", { body: null, timedOut: true });
    }
    const callback = await ctx.callback({ timeoutMs: durationMs(input.timeout) });
    const notify = input.notify;
    if (!notify) return suspend({ callback });
    return suspend({
      callback,
      afterCommit: ({ signal }) => sendNotify(notify.url, callback, ctx, signal),
    });
  },
});
