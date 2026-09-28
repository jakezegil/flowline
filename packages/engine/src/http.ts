/**
 * The SSRF-guarded `fetch` behind `ctx.http.fetch`.
 *
 * Every hop (the first request and each redirect) is checked before connecting: the scheme must
 * be `http:`/`https:`, the host must be in `allowHosts` (when given), and every address the host
 * resolves to must be public (unless `allowPrivateNetworks`). The connection is then pinned to the
 * addresses that were checked, through an undici dispatcher whose `lookup` returns only those
 * addresses, so a DNS answer that changes between check and connect (DNS rebinding) cannot
 * redirect it. TLS still uses the hostname for SNI and certificate checks.
 *
 * @module
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { isPrivateAddress, type Logger, normalizeHost } from "@flowline/core";
import { Agent, fetch as undiciFetch } from "undici";
import { FatalError, RetryableError } from "./errors";

/** One resolved address. `family` is 4 or 6. */
export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Resolves a hostname to all of its addresses. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

/** Network policy of `ctx.http.fetch` (see `EngineOptions.http`). */
export interface HttpPolicy {
  /** Allow loopback, private, link-local and other non-public addresses. Default `false`. */
  allowPrivateNetworks?: boolean;
  /** When given, only these hostnames (case-insensitive, exact match) may be requested. */
  allowHosts?: string[];
  /** Maximum response body size in bytes. Default 10 MB. */
  maxResponseBytes?: number;
}

/** @internal {@link HttpPolicy} plus test seams. */
export interface GuardedFetchOptions extends HttpPolicy {
  /** DNS resolver. Default: `node:dns/promises` `lookup` with `all: true`. */
  resolve?: Resolver;
  /** Address classifier. Default: `isPrivateAddress`. */
  isPrivate?: (ip: string) => boolean;
  /** Receives diagnostics that must not reach users, such as the resolved address of a blocked host. */
  logger?: Logger;
}

/**
 * `RequestInit` plus `timeoutMs`, an overall time budget that bounds connect, header and body
 * timeouts, and `credentialHeaders`, header names (case-insensitive) that carry credentials and
 * are therefore dropped on a cross-origin redirect even when safelisted.
 */
export type GuardedFetchInit = RequestInit & { timeoutMs?: number; credentialHeaders?: string[] };

/** A `fetch` subset: string URL and {@link GuardedFetchInit}. */
export type GuardedFetch = (url: string, init?: GuardedFetchInit) => Promise<Response>;

/** Default {@link HttpPolicy.maxResponseBytes}: 10 MB. */
export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
/** Request headers kept when a redirect changes origin (`content-type` only while the body is). */
const CROSS_ORIGIN_SAFE_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-language",
  "content-type",
  "user-agent",
  "idempotency-key",
]);
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 300_000;

const systemResolver: Resolver = async (hostname) => dnsLookup(hostname, { all: true });

/** Says how to allow the host, since `allowHosts` restricts hosts and never unblocks one. */
const BLOCKED_HINT =
  "(to reach private or local hosts, e.g. a mock API, set createEngine({ http: { allowPrivateNetworks: true } }); allowHosts only restricts)";

function blocked(host: string): FatalError {
  return new FatalError(`blocked private network address: ${host} ${BLOCKED_HINT}`, {
    code: "SSRF_BLOCKED",
  });
}

/** Validates `url` against the policy and returns the addresses the connection may use. */
async function checkTarget(
  url: URL,
  opts: GuardedFetchOptions,
  allowHosts: Set<string> | undefined,
  signal: AbortSignal | undefined,
): Promise<ResolvedAddress[]> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FatalError(`unsupported URL scheme "${url.protocol}"`, { code: "SSRF_BLOCKED" });
  }
  if (url.username !== "" || url.password !== "") {
    throw new FatalError("URLs with embedded credentials are not allowed");
  }
  const host = normalizeHost(url.hostname);
  if (allowHosts && !allowHosts.has(host)) {
    throw new FatalError(`host "${host}" is not in the allowed hosts list`, {
      code: "SSRF_BLOCKED",
    });
  }
  const allowPrivate = opts.allowPrivateNetworks === true;
  const isPrivate = opts.isPrivate ?? isPrivateAddress;
  const family = isIP(host);
  if (family !== 0) {
    if (!allowPrivate && isPrivate(host)) throw blocked(host);
    return [{ address: host, family }];
  }
  if (!allowPrivate && (host === "localhost" || host.endsWith(".localhost"))) throw blocked(host);
  let addresses: ResolvedAddress[];
  try {
    addresses = await abortable((opts.resolve ?? systemResolver)(host), signal);
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    throw new RetryableError(`could not resolve host "${host}"`, { cause: err });
  }
  if (addresses.length === 0) throw new RetryableError(`could not resolve host "${host}"`);
  if (!allowPrivate) {
    const bad = addresses.find((a) => isPrivate(a.address));
    if (bad) {
      opts.logger?.warn("ctx.http.fetch blocked a private network address", {
        host,
        address: bad.address,
      });
      throw blocked(host);
    }
  }
  return addresses;
}

/** Rejects with the signal's reason as soon as it aborts, whether or not `p` has settled. */
function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Keeps only the headers that may follow a request to another origin. */
function crossOriginHeaders(
  headers: Headers,
  keepBody: boolean,
  credentials: ReadonlySet<string>,
): Headers {
  const out = new Headers();
  headers.forEach((value, key) => {
    if (!CROSS_ORIGIN_SAFE_HEADERS.has(key) || credentials.has(key)) return;
    if (key === "content-type" && !keepBody) return;
    out.set(key, value);
  });
  return out;
}

/** A `lookup` that answers every query with the pre-checked addresses. */
function pinnedLookup(addresses: ResolvedAddress[]): LookupFunction {
  const first = addresses[0] as ResolvedAddress;
  return ((
    _hostname: string,
    options: { all?: boolean } | undefined,
    callback: (err: null, address: string | ResolvedAddress[], family?: number) => void,
  ) => {
    if (options?.all) callback(null, addresses);
    else callback(null, first.address, first.family);
  }) as unknown as LookupFunction;
}

function toRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return new Uint8Array(new ArrayBuffer(0));
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw tooLarge(max);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function tooLarge(max: number): FatalError {
  return new FatalError(`response body exceeds ${max} bytes`, { code: "RESPONSE_TOO_LARGE" });
}

/**
 * @internal Create the SSRF-guarded fetch for a policy. Redirects are followed manually (up to 5),
 * each hop re-checked; a 303 (or a 301/302 after POST) continues as GET without a body, and
 * when a redirect changes origin only safelisted headers (Accept, Accept-Language,
 * Content-Language, Content-Type while the body is kept, User-Agent, Idempotency-Key) follow it,
 * minus any named in `init.credentialHeaders`. `init.redirect: "error"` fails on a redirect
 * instead (a `FatalError`, nothing re-sent) and `"manual"` returns the redirect response as is.
 * `init.timeoutMs` bounds the connect, header and body timeouts. The response body is read fully
 * (up to `maxResponseBytes`) before the returned `Response` resolves.
 */
export function createGuardedFetch(opts: GuardedFetchOptions = {}): GuardedFetch {
  const allowHosts = opts.allowHosts ? new Set(opts.allowHosts.map(normalizeHost)) : undefined;
  const max = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return async (input, init = {}) => {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new FatalError("invalid URL");
    }
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body ?? undefined;
    let headers = new Headers(init.headers);
    const signal = init.signal ?? undefined;
    const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const connectTimeout = Math.min(DEFAULT_CONNECT_TIMEOUT_MS, timeoutMs);
    const credentials = new Set((init.credentialHeaders ?? []).map((h) => h.toLowerCase()));
    const redirect = init.redirect ?? "follow";

    for (let hop = 0; ; hop++) {
      const addresses = await checkTarget(url, opts, allowHosts, signal);
      const dispatcher = new Agent({
        connect: { lookup: pinnedLookup(addresses), timeout: connectTimeout },
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
      try {
        const res = await undiciFetch(url, {
          method,
          headers: toRecord(headers),
          body: body as never,
          redirect: "manual",
          signal: signal ?? null,
          dispatcher,
        });
        const location = res.headers.get("location");
        if (REDIRECT_STATUSES.has(res.status) && location !== null && redirect !== "manual") {
          await res.body?.cancel().catch(() => {});
          if (redirect === "error") throw new FatalError("redirects are not allowed");
          if (hop >= MAX_REDIRECTS) throw new FatalError("too many redirects");
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            throw new FatalError("invalid redirect URL");
          }
          if (
            res.status === 303 ||
            ((res.status === 301 || res.status === 302) && method === "POST")
          ) {
            if (method !== "HEAD") method = "GET";
            body = undefined;
            headers.delete("content-type");
            headers.delete("content-length");
          } else if (body instanceof ReadableStream) {
            throw new FatalError("cannot replay a streamed request body on redirect");
          }
          if (next.origin !== url.origin) {
            headers = crossOriginHeaders(headers, body !== undefined, credentials);
          }
          url = next;
          continue;
        }
        const length = Number(res.headers.get("content-length") ?? Number.NaN);
        if (length > max) {
          await res.body?.cancel().catch(() => {});
          throw tooLarge(max);
        }
        const bytes = await readCapped(res.body as ReadableStream<Uint8Array> | null, max);
        const outHeaders = new Headers(res.headers as unknown as Headers);
        if (outHeaders.has("content-encoding")) {
          // The body was decoded; its encoded length and encoding no longer apply.
          outHeaders.delete("content-encoding");
          outHeaders.delete("content-length");
        }
        return new Response(NULL_BODY_STATUSES.has(res.status) ? null : bytes, {
          status: res.status,
          statusText: res.statusText,
          headers: outHeaders,
        });
      } finally {
        await dispatcher.destroy().catch(() => {});
      }
    }
  };
}
