/**
 * Built-in triggers: `core.event`, `core.webhook`, `core.manual`, `core.schedule` and
 * `core.subflow`.
 *
 * @module
 */
import { defineTrigger, fields, secret, ui } from "@flowlinejs/core";
import { z } from "zod";
import { durationSchema } from "./time";

/** Five (or six, with seconds) space-separated cron fields. Full parsing happens when scheduling. */
const CRON = /^\s*\S+(\s+\S+){4,5}\s*$/;

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts a run when the host app emits an event with the configured name
 * (`engine.emit(name, payload)`). The payload is untyped; plugin triggers are preferred where a
 * typed payload is available.
 */
export const eventTrigger = defineTrigger({
  type: "core.event",
  name: "App event",
  description:
    "Start when your app emits an event with this name. The event's data is available as the trigger.",
  icon: "zap",
  kind: "event",
  config: z.object({
    event: ui(z.string().min(1, "Enter an event name"), {
      label: "Event name",
      placeholder: "deal.updated",
    }),
  }),
  payload: z.unknown(),
});

/**
 * Starts a run when its webhook URL receives a POST. The payload is
 * `{ body: <declared fields>, headers: Record<string, string> }`.
 */
export const webhookTrigger = defineTrigger({
  type: "core.webhook",
  name: "Webhook",
  description: "Start when another system sends a POST request to this workflow's webhook URL.",
  icon: "webhook",
  kind: "webhook",
  config: z.object({
    fields: ui(fields(), { label: "Body fields" })
      .describe(
        "The fields you expect in the JSON body. Requests missing a required field are rejected.",
      )
      .default([]),
    secret: ui(secret(), { label: "Signing secret" })
      .describe(
        "Verify the X-Flowline-Signature header (HMAC-SHA256 of the body) with this secret.",
      )
      .optional(),
    dedupeHeader: ui(z.string(), { label: "Deduplication header", placeholder: "X-Request-Id" })
      .describe("Requests repeating this header's value start no new run.")
      .optional(),
    dedupeWindow: ui(durationSchema(), { label: "Deduplication window", placeholder: "7d" })
      .describe(
        "How long a repeated header value starts no new run. Leave empty for the default (7 days unless your app changes it).",
      )
      .optional(),
  }),
  dynamicPayload: { kind: "webhook", configPath: "fields" },
});

/** Starts a run on demand (from the editor, the API or code), with the declared input fields. */
export const manualTrigger = defineTrigger({
  type: "core.manual",
  name: "Manual",
  description:
    "Start by hand from the editor, the API or your own code, with the input you define.",
  icon: "play",
  kind: "manual",
  config: z.object({
    fields: ui(fields(), { label: "Input fields" })
      .describe("What to ask for when starting a run.")
      .default([]),
  }),
  dynamicPayload: { kind: "fields", configPath: "fields" },
});

/**
 * Starts a run on a cron schedule in a time zone. After downtime only the latest missed fire
 * starts a run.
 */
export const scheduleTrigger = defineTrigger({
  type: "core.schedule",
  name: "Schedule",
  description: "Start on a repeating schedule, such as every weekday at 9:00.",
  icon: "calendar-clock",
  kind: "schedule",
  config: z.object({
    cron: ui(z.string().regex(CRON, "Use a cron expression with five fields, e.g. 0 9 * * 1-5"), {
      label: "Schedule (cron)",
      placeholder: "0 9 * * 1-5",
    }).describe("Minute, hour, day of month, month and day of week."),
    timezone: ui(
      z.string().refine(isTimeZone, { error: (issue) => `Unknown time zone "${issue.input}"` }),
      { label: "Time zone", placeholder: "Europe/Berlin" },
    ).default("UTC"),
  }),
  payload: z.object({
    firedAt: z.iso.datetime().describe("The scheduled time this run was started for."),
  }),
});

/**
 * Makes the workflow callable from other workflows with `core.callSubflow`. `input` declares the
 * trigger payload; `output` declares what the workflow's output mapping returns to the caller
 * (checked when the sub-flow finishes).
 */
export const subflowTrigger = defineTrigger({
  type: "core.subflow",
  name: "Sub-flow",
  description:
    "Let other workflows run this one with Run sub-flow. Declare the input it takes and the output it returns.",
  icon: "log-in",
  kind: "subflow",
  config: z.object({
    input: ui(fields(), { label: "Input fields" }).describe("What callers pass in.").default([]),
    output: ui(fields(), { label: "Output fields" })
      .describe("What this workflow returns to its caller.")
      .default([]),
  }),
  dynamicPayload: { kind: "fields", configPath: "input" },
});
