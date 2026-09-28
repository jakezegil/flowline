/**
 * `core.httpRequest`: an HTTP call through the engine's SSRF-guarded `ctx.http.fetch`.
 *
 * @module
 */
import { defineNode, FatalError, RetryableError, sensitive, ui } from "@flowkit/core";
import { z } from "zod";

const stringRecord = () => z.record(z.string(), z.string());

function isFatal(err: unknown): boolean {
  return err instanceof Error && err.name === "FatalError";
}

function isJsonContentType(type: string | null): boolean {
  if (type === null) return false;
  const mime = type.split(";")[0]?.trim().toLowerCase() ?? "";
  return mime === "application/json" || mime.endsWith("+json");
}

function encodeBody(
  bodyType: "none" | "json" | "form" | "text",
  body: unknown,
  headers: Headers,
): BodyInit | undefined {
  switch (bodyType) {
    case "none":
      return undefined;
    case "json":
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      return JSON.stringify(body ?? null);
    case "form": {
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new FatalError("A form body must be an object of fields");
      }
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined && v !== null)
          form.append(k, typeof v === "string" ? v : JSON.stringify(v));
      }
      return form;
    }
    case "text":
      return typeof body === "string" ? body : JSON.stringify(body ?? "");
  }
}

/**
 * `core.httpRequest`: send an HTTP request and return `{ status, headers, body }` (`body` parsed
 * when the response is JSON, text otherwise).
 *
 * Requests go through `ctx.http.fetch`, which blocks private networks and hosts outside the
 * engine's allow list and caps the response size. 5xx, 429, network errors and timeouts are
 * retried; other 4xx fail the step unless `failOnHttpError` is off. Sends `Idempotency-Key:
 * ctx.idempotencyKey` (stable across retries) unless disabled or set explicitly. `headers` is
 * marked sensitive, so its values are masked in run events; they never appear in the output.
 */
export const httpRequest = defineNode({
  type: "core.httpRequest",
  name: "HTTP request",
  description: "Call an external HTTP API.",
  icon: "globe",
  category: "Integrations",
  summary: "{{method}} {{url}}",
  input: z.object({
    method: ui(z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), { label: "Method" }),
    url: ui(z.string(), { label: "URL", placeholder: "https://api.example.com/items" }),
    headers: sensitive(ui(stringRecord(), { label: "Headers" })).optional(),
    query: ui(stringRecord(), { label: "Query parameters" }).optional(),
    bodyType: ui(z.enum(["none", "json", "form", "text"]), { label: "Body type" }).default("none"),
    body: ui(z.unknown(), { label: "Body" }).optional(),
    timeoutMs: ui(z.number().int().positive(), {
      label: "Timeout (ms)",
      group: "Advanced",
    }).default(30_000),
    sendIdempotencyKey: ui(z.boolean(), {
      label: "Send Idempotency-Key header",
      group: "Advanced",
    }).default(true),
    failOnHttpError: ui(z.boolean(), {
      label: "Fail on 4xx responses",
      group: "Advanced",
    }).default(true),
  }),
  output: z.object({
    status: z.number(),
    headers: stringRecord(),
    body: z.unknown(),
  }),
  async run({ input, ctx }) {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new FatalError("Invalid URL");
    }
    for (const [k, v] of Object.entries(input.query ?? {})) url.searchParams.append(k, v);

    if (input.method === "GET" && input.bodyType !== "none") {
      throw new FatalError("GET requests cannot have a body");
    }
    const headers = new Headers(input.headers);
    if (input.sendIdempotencyKey && !headers.has("idempotency-key")) {
      headers.set("idempotency-key", ctx.idempotencyKey);
    }
    const body = encodeBody(input.bodyType, input.body, headers);

    const timeout = AbortSignal.timeout(input.timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await ctx.http.fetch(url.toString(), {
        method: input.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.any([ctx.signal, timeout]),
      });
      text = await res.text();
    } catch (err) {
      if (isFatal(err)) throw err;
      if (timeout.aborted) {
        throw new RetryableError(`HTTP request timed out after ${input.timeoutMs}ms`, {
          cause: err,
        });
      }
      const reason =
        err instanceof Error
          ? err.cause instanceof Error
            ? err.cause.message
            : err.message
          : String(err);
      throw new RetryableError(`HTTP request failed: ${reason}`, { cause: err });
    }

    if (res.status >= 500 || res.status === 429) {
      throw new RetryableError(`HTTP ${res.status} ${res.statusText}`.trim());
    }
    if (res.status >= 400 && input.failOnHttpError) {
      throw new FatalError(`HTTP ${res.status} ${res.statusText}`.trim(), {
        code: `HTTP_${res.status}`,
      });
    }

    let parsed: unknown = text;
    if (isJsonContentType(res.headers.get("content-type")) && text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    return { status: res.status, headers: responseHeaders, body: parsed };
  },
});
