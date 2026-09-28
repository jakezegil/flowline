/**
 * `core.httpRequest`: an HTTP call through the engine's SSRF-guarded `ctx.http.fetch`.
 *
 * @module
 */
import {
  defineNode,
  FatalError,
  type NodeContext,
  RetryableError,
  secret,
  sensitive,
  ui,
} from "@flowkit/core";
import { z } from "zod";

const stringRecord = () => z.record(z.string(), z.string());

/** An HTTP header field name (RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const secretName = () => ui(secret(z.string().min(1)), { label: "Secret" });

/**
 * Authentication config. A union keyed by `type`, so the manifest's JSON Schema (and with it the
 * validator) requires `secret` for every type but `none`, and `headerName` for `header`.
 */
const authSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer"), secret: secretName() }),
  z.object({
    type: z.literal("basic"),
    secret: secretName().describe('The secret holds "user:password".'),
  }),
  z.object({
    type: z.literal("header"),
    secret: secretName(),
    headerName: ui(z.string().regex(HEADER_NAME, "Must be a valid header name"), {
      label: "Header name",
      placeholder: "X-Api-Key",
    }),
  }),
]);

type Auth = z.infer<typeof authSchema>;

function base64Utf8(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Sets the authentication header, overriding any same-named header from `input.headers`. The
 * secret's value never appears in errors.
 */
async function applyAuth(auth: Auth, headers: Headers, ctx: NodeContext): Promise<void> {
  if (auth.type === "none") return;
  // The schema requires these; re-check in case the handler is called with unvalidated input.
  if (typeof auth.secret !== "string" || auth.secret === "") {
    throw new FatalError(`Authentication "${auth.type}" needs a secret`);
  }
  if (auth.type === "header" && !HEADER_NAME.test(auth.headerName ?? "")) {
    throw new FatalError("Header authentication needs a valid header name");
  }
  const value = await ctx.secrets.get(auth.secret);
  try {
    if (auth.type === "bearer") headers.set("authorization", `Bearer ${value}`);
    else if (auth.type === "basic") headers.set("authorization", `Basic ${base64Utf8(value)}`);
    else headers.set(auth.headerName, value);
  } catch {
    throw new FatalError(`Secret "${auth.secret}" is not a valid header value`);
  }
}

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
 * ctx.idempotencyKey` (stable across retries) unless disabled or set explicitly.
 *
 * Credentials belong in `auth`, which names a host secret (`bearer`, `basic` with a
 * `user:password` secret, or a custom `header`); its header overrides one of the same name in
 * `headers`, and the secret's value never reaches the step's config, output, errors or events.
 * `headers` is marked sensitive, so its values are masked in run events; request headers never
 * appear in the output.
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
    headers: sensitive(ui(stringRecord(), { label: "Headers" }))
      .describe("Don't put credentials here; use Authentication.")
      .optional(),
    query: ui(stringRecord(), { label: "Query parameters" }).optional(),
    bodyType: ui(z.enum(["none", "json", "form", "text"]), { label: "Body type" }).default("none"),
    body: ui(z.unknown(), { label: "Body" }).optional(),
    auth: ui(authSchema, { label: "Authentication" }).default({ type: "none" }),
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
    await applyAuth(input.auth, headers, ctx);
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
        timeoutMs: input.timeoutMs,
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
