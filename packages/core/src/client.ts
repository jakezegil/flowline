/**
 * Isomorphic HTTP client for the Flowkit engine's HTTP handler, exported as
 * `@flowkit/core/client`. Uses the platform `fetch`; works in browsers, Node 22+, and edge runtimes.
 *
 * @module
 */
import type {
  RunDetail,
  RunEvent,
  RunStatus,
  RunSummary,
  SubflowInfo,
  TestStepRequest,
  TestStepResponse,
  WorkflowDetail,
  WorkflowSummary,
  WorkflowVersion,
} from "./api-types";
import type { Manifest, WorkflowDoc } from "./types";
import type { Issue } from "./validate";

export type * from "./api-types";
export type { Issue, Manifest, WorkflowDoc };

/** Typed access to every route of the Flowkit HTTP handler. */
export interface FlowkitClient {
  /** `GET /manifest` — plugins, nodes and triggers available to the editor. */
  getManifest(): Promise<Manifest>;
  /** `GET /workflows` — the tenant's workflows. */
  listWorkflows(): Promise<WorkflowSummary[]>;
  /** `GET /workflows/:id` — latest and published versions. */
  getWorkflow(id: string): Promise<WorkflowDetail>;
  /** `PUT /workflows/:id` — save `doc` as a new immutable version. */
  saveWorkflow(doc: WorkflowDoc): Promise<WorkflowVersion>;
  /** `POST /workflows/:id/publish` — publish `version`; rejects with 422 if it has errors. */
  publish(id: string, version: number): Promise<void>;
  /** `POST /workflows/validate` — server-side validation issues for `doc`. */
  validate(doc: WorkflowDoc): Promise<Issue[]>;
  /** `GET /subflows` — published workflows callable as sub-flows. */
  listSubflows(): Promise<SubflowInfo[]>;
  /** `GET /secrets` — names (never values) of configured secrets. */
  listSecrets(): Promise<string[]>;
  /** `POST /workflows/:id/test-step` — run one step against sample data (`id` = `req.doc.id`). */
  testStep(req: TestStepRequest): Promise<TestStepResponse>;
  /** `POST /workflows/:id/run` — start a manual run of the published version. */
  runWorkflow(id: string, input?: unknown): Promise<{ runId: string }>;
  /** `GET /runs` — runs, optionally filtered. */
  listRuns(filter?: {
    workflowId?: string;
    status?: RunStatus;
    limit?: number;
  }): Promise<RunSummary[]>;
  /** `GET /runs/:id` — run with journal, events and pinned doc. */
  getRun(id: string): Promise<RunDetail>;
  /** `POST /runs/:id/retry` — retry a failed run. */
  retryRun(id: string): Promise<{ runId: string }>;
  /** `POST /runs/:id/cancel` — cancel a run. */
  cancelRun(id: string): Promise<void>;
  /** `POST /runs/:id/resume` — authorized resume of a run waiting on a callback, with `body` as the callback body. */
  resumeRun(id: string, body?: unknown): Promise<void>;
  /**
   * Stream a run's events from `GET /runs/:id/stream`. Uses `fetch` (so `headers()` auth works),
   * reconnects with `?after=<lastSeq>` and exponential backoff (500ms doubling to 10s), delivers
   * each `seq` at most once and in order, and stops once the run's latest event is
   * `run.completed`, `run.failed`, `run.cancelled` or `run.stopped` (the server closes the stream
   * right after it; a retried run's earlier `run.failed` does not stop it), or on a
   * non-retryable 4xx response. Falls back to polling `getRun` every 2s
   * when the runtime cannot stream response bodies.
   *
   * @returns A function that unsubscribes and closes the stream.
   */
  subscribeRun(id: string, onEvent: (e: RunEvent) => void): () => void;
}

/** Thrown by {@link FlowkitClient} methods for non-2xx responses. */
export class FlowkitHttpError extends Error {
  /** Error name, for `instanceof`-free checks across package copies. */
  override readonly name = "FlowkitHttpError";
  /** HTTP status code. */
  readonly status: number;
  /** Parsed JSON response body, or the raw text when it is not JSON. */
  readonly body: unknown;

  /** Create an error for a failed `method path` request. */
  constructor(method: string, path: string, status: number, body: unknown) {
    const serverError =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : undefined;
    super(`${method} ${path} failed (${status})${serverError ? `: ${serverError}` : ""}`);
    this.status = status;
    this.body = body;
  }
}

/** Options for {@link createClient}. */
export interface ClientOptions {
  /** URL (absolute or same-origin relative) of the handler's base path, e.g. `"/flowkit"`. */
  baseUrl: string;
  /** `fetch` implementation; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Extra headers (e.g. auth) computed before every request, including stream reconnects. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
}

const TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.stopped",
]);
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);
const BACKOFF_INITIAL_MS = 500;
const BACKOFF_MAX_MS = 10_000;
const POLL_INTERVAL_MS = 2_000;

/** 4xx statuses (other than timeout / rate limit) mean retrying cannot help. */
function isRetryableStatus(status: number): boolean {
  return !(status >= 400 && status < 500 && status !== 408 && status !== 429);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** One dispatched server-sent event. */
interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

/**
 * Incremental `text/event-stream` parser (WHATWG HTML §9.2.6): accepts arbitrary text chunks,
 * handles `\n`, `\r\n` and `\r` line endings split across chunks, ignores `:` comments.
 */
class SseParser {
  #buffer = "";
  #event = "";
  #data: string[] = [];
  #id: string | undefined;

  push(chunk: string): SseMessage[] {
    this.#buffer += chunk;
    const out: SseMessage[] = [];
    let start = 0;
    const buf = this.#buffer;
    for (let i = 0; i < buf.length; i++) {
      const c = buf.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      // A trailing CR may be the first half of CRLF; wait for the next chunk.
      if (c === 13 && i === buf.length - 1) break;
      const msg = this.#line(buf.slice(start, i));
      if (msg) out.push(msg);
      if (c === 13 && buf.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
    }
    this.#buffer = buf.slice(start);
    return out;
  }

  #line(line: string): SseMessage | undefined {
    if (line === "") {
      const data = this.#data;
      const event = this.#event || "message";
      this.#data = [];
      this.#event = "";
      if (data.length === 0) return undefined;
      return { event, data: data.join("\n"), ...(this.#id !== undefined ? { id: this.#id } : {}) };
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.#data.push(value);
    else if (field === "event") this.#event = value;
    else if (field === "id" && !value.includes("\0")) this.#id = value;
    return undefined;
  }
}

/**
 * Create a client for a Flowkit HTTP handler mounted at `baseUrl`.
 *
 * @example
 * ```ts
 * import { createClient } from "@flowkit/core/client";
 * const client = createClient({
 *   baseUrl: "/flowkit",
 *   headers: async () => ({ authorization: `Bearer ${await getToken()}` }),
 * });
 * const runs = await client.listRuns({ status: "failed" });
 * ```
 */
export function createClient(opts: ClientOptions): FlowkitClient {
  const base = opts.baseUrl.replace(/\/+$/, "");
  // Resolve lazily and call unbound: browsers throw "Illegal invocation" for a detached `fetch`.
  const doFetch = (url: string, init: RequestInit) => (opts.fetch ?? globalThis.fetch)(url, init);
  const extraHeaders = async () => (opts.headers ? await opts.headers() : {});
  const enc = encodeURIComponent;

  async function request<T>(
    method: string,
    path: string,
    body?: { value: unknown },
    signal?: AbortSignal,
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(await extraHeaders()),
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined && body.value !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body.value);
    }
    if (signal) init.signal = signal;
    const res = await doFetch(base + path, init);
    const parsed = await readBody(res);
    if (!res.ok) throw new FlowkitHttpError(method, path, res.status, parsed);
    return parsed as T;
  }

  const client: FlowkitClient = {
    getManifest: () => request("GET", "/manifest"),
    listWorkflows: () => request("GET", "/workflows"),
    getWorkflow: (id) => request("GET", `/workflows/${enc(id)}`),
    saveWorkflow: (doc) => request("PUT", `/workflows/${enc(doc.id)}`, { value: doc }),
    publish: async (id, version) => {
      await request("POST", `/workflows/${enc(id)}/publish`, { value: { version } });
    },
    validate: (doc) => request("POST", "/workflows/validate", { value: doc }),
    listSubflows: () => request("GET", "/subflows"),
    listSecrets: () => request("GET", "/secrets"),
    testStep: (req) => request("POST", `/workflows/${enc(req.doc.id)}/test-step`, { value: req }),
    runWorkflow: (id, input) =>
      request("POST", `/workflows/${enc(id)}/run`, {
        value: input === undefined ? {} : { input },
      }),
    listRuns: (filter = {}) => {
      const params = new URLSearchParams();
      if (filter.workflowId !== undefined) params.set("workflowId", filter.workflowId);
      if (filter.status !== undefined) params.set("status", filter.status);
      if (filter.limit !== undefined) params.set("limit", String(filter.limit));
      const qs = params.toString();
      return request("GET", `/runs${qs ? `?${qs}` : ""}`);
    },
    getRun: (id) => request("GET", `/runs/${enc(id)}`),
    retryRun: (id) => request("POST", `/runs/${enc(id)}/retry`),
    cancelRun: async (id) => {
      await request("POST", `/runs/${enc(id)}/cancel`);
    },
    resumeRun: async (id, body) => {
      await request("POST", `/runs/${enc(id)}/resume`, { value: body });
    },
    subscribeRun: (id, onEvent) => subscribe(id, onEvent),
  };

  function subscribe(id: string, onEvent: (e: RunEvent) => void): () => void {
    const ac = new AbortController();
    const { signal } = ac;
    let lastSeq: number | undefined;

    /**
     * Whether the last delivered event is terminal. A terminal event ends the subscription only
     * when nothing follows it: a retried run continues after its old `run.failed`, so the stream
     * is read on until the server closes it.
     */
    let atTerminal = false;

    /** Delivers `e` unless already seen. */
    function deliver(e: RunEvent): void {
      if (lastSeq !== undefined && e.seq <= lastSeq) return;
      lastSeq = e.seq;
      atTerminal = TERMINAL_EVENTS.has(e.type);
      try {
        onEvent(e);
      } catch (err) {
        // A throwing listener must not break the stream; surface it as an uncaught error.
        queueMicrotask(() => {
          throw err;
        });
      }
    }

    async function poll(): Promise<void> {
      while (!signal.aborted) {
        try {
          const detail = await request<RunDetail>("GET", `/runs/${enc(id)}`, undefined, signal);
          const events = [...detail.events].sort((a, b) => a.seq - b.seq);
          for (const e of events) deliver(e);
          // A snapshot is the whole log: done when its latest event is terminal.
          const last = events[events.length - 1];
          if (last && TERMINAL_EVENTS.has(last.type)) return;
          if (detail.run.status !== undefined && TERMINAL_STATUSES.has(detail.run.status)) return;
        } catch (err) {
          if (err instanceof FlowkitHttpError && !isRetryableStatus(err.status)) return;
        }
        await sleep(POLL_INTERVAL_MS, signal);
      }
    }

    /**
     * Reads one stream to its end; returns whether it ended right after a terminal event (the
     * server closes the stream once the run's latest event is terminal).
     */
    async function readStream(body: ReadableStream<Uint8Array>, onMessage: () => void) {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return atTerminal;
          for (const msg of parser.push(decoder.decode(value, { stream: true }))) {
            if (msg.event !== "run") continue;
            let e: RunEvent;
            try {
              e = JSON.parse(msg.data) as RunEvent;
            } catch {
              continue;
            }
            onMessage();
            deliver(e);
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    }

    async function run(): Promise<void> {
      let backoff = BACKOFF_INITIAL_MS;
      while (!signal.aborted) {
        try {
          const path = `/runs/${enc(id)}/stream${lastSeq !== undefined ? `?after=${lastSeq}` : ""}`;
          const res = await doFetch(base + path, {
            method: "GET",
            headers: { ...(await extraHeaders()), accept: "text/event-stream" },
            signal,
          });
          if (!res.ok) {
            await res.body?.cancel().catch(() => {});
            if (!isRetryableStatus(res.status)) return;
          } else if (!res.body || typeof res.body.getReader !== "function") {
            return await poll();
          } else if (
            await readStream(res.body, () => {
              backoff = BACKOFF_INITIAL_MS;
            })
          ) {
            return;
          }
        } catch {
          // Network error or aborted stream: fall through to backoff (or exit if unsubscribed).
        }
        if (signal.aborted) return;
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }

    void run().finally(() => ac.abort());
    return () => ac.abort();
  }

  return client;
}
