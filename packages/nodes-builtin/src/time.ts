/**
 * Timing nodes: `core.delay` and `core.waitForCallback`.
 *
 * @module
 */
import { branch, defineNode, suspend, ui } from "@flowkit/core";
import { z } from "zod";

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const DURATION = /^([1-9][0-9]*)([smhd])$/;
const DURATION_MESSAGE = "Use a whole number and a unit: 30s, 5m, 2h or 3d";

/**
 * Milliseconds in a duration such as `"30s"`, `"5m"`, `"2h"` or `"3d"` (a positive whole number
 * followed by `s`, `m`, `h` or `d`), or `undefined` if `text` is not one.
 */
export function parseDuration(text: string): number | undefined {
  const match = DURATION.exec(text);
  if (!match) return undefined;
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

const duration = () => z.string().regex(DURATION, DURATION_MESSAGE);

/** Pauses the run for a duration or until a point in time, then continues. */
export const delayNode = defineNode({
  type: "core.delay",
  name: "Delay",
  description: "Pause the run for a while, or until a date and time, then continue.",
  icon: "timer",
  category: "Timing",
  summary: "Wait {{duration}}{{until}}",
  input: z
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
  output: z.object({
    resumedAt: z.iso.datetime().describe("When the run continued."),
  }),
  run: ({ input, ctx }) => {
    const resumedAt = () => ({ resumedAt: new Date(ctx.now()).toISOString() });
    if (ctx.resume?.kind === "timer") return resumedAt();
    const until =
      input.until !== undefined
        ? Date.parse(input.until)
        : ctx.now() + (parseDuration(input.duration ?? "") ?? 0);
    return until <= ctx.now() ? resumedAt() : suspend({ until });
  },
});

/**
 * Pauses the run until an external system calls the step's one-time resume URL (taking the
 * `resumed` branch with the request body) or the timeout passes (taking `timeout`).
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
    const callback = await ctx.callback({ timeoutMs: parseDuration(input.timeout) ?? 0 });
    return suspend({ callback });
  },
});
