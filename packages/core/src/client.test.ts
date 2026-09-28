import { afterEach, describe, expect, test, vi } from "vitest";
import type { RunEvent } from "./api-types";
import { createClient, FlowlineHttpError } from "./client";
import type { WorkflowDoc } from "./types";

interface Call {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

function stubFetch(respond: (call: Call) => Response | Promise<Response> = () => json({})) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const raw = init?.body;
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      body: typeof raw === "string" ? JSON.parse(raw) : raw,
      headers,
    };
    calls.push(call);
    return respond(call);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const doc: WorkflowDoc = {
  id: "wf 1",
  name: "WF",
  trigger: { type: "core.manual", config: {} },
  steps: [],
};

function event(seq: number, type: RunEvent["type"] = "step.completed"): RunEvent {
  return { id: `e${seq}`, runId: "r1", tenantId: "t", seq, type, at: seq };
}

describe("createClient requests", () => {
  const cases: {
    name: string;
    call: (c: ReturnType<typeof createClient>) => Promise<unknown>;
    method: string;
    path: string;
    body?: unknown;
    response?: unknown;
    status?: number;
    expected?: unknown;
  }[] = [
    { name: "getManifest", call: (c) => c.getManifest(), method: "GET", path: "/manifest" },
    {
      name: "listWorkflows",
      call: (c) => c.listWorkflows(),
      method: "GET",
      path: "/workflows",
      response: [],
      expected: [],
    },
    {
      name: "getWorkflow",
      call: (c) => c.getWorkflow("a/b"),
      method: "GET",
      path: "/workflows/a%2Fb",
    },
    {
      name: "saveWorkflow",
      call: (c) => c.saveWorkflow(doc),
      method: "PUT",
      path: "/workflows/wf%201",
      body: doc,
    },
    {
      name: "saveWorkflow creating",
      call: (c) => c.saveWorkflow(doc, { create: true }),
      method: "PUT",
      path: "/workflows/wf%201?create=true",
      body: doc,
    },
    {
      name: "publish",
      call: (c) => c.publish("wf", 3),
      method: "POST",
      path: "/workflows/wf/publish",
      body: { version: 3 },
      status: 204,
      expected: undefined,
    },
    {
      name: "validate",
      call: (c) => c.validate(doc),
      method: "POST",
      path: "/workflows/validate",
      body: doc,
      response: [{ code: "x" }],
      expected: [{ code: "x" }],
    },
    { name: "listSubflows", call: (c) => c.listSubflows(), method: "GET", path: "/subflows" },
    { name: "listSecrets", call: (c) => c.listSecrets(), method: "GET", path: "/secrets" },
    {
      name: "testStep",
      call: (c) =>
        c.testStep({ step: { id: "s", type: "a.b", config: {} }, doc, samples: { x: 1 } }),
      method: "POST",
      path: "/workflows/wf%201/test-step",
      body: { step: { id: "s", type: "a.b", config: {} }, doc, samples: { x: 1 } },
    },
    {
      name: "runWorkflow",
      call: (c) => c.runWorkflow("wf", { a: 1 }),
      method: "POST",
      path: "/workflows/wf/run",
      body: { input: { a: 1 } },
      response: { runId: "r1" },
      expected: { runId: "r1" },
    },
    {
      name: "runWorkflow without input",
      call: (c) => c.runWorkflow("wf"),
      method: "POST",
      path: "/workflows/wf/run",
      body: {},
    },
    { name: "listRuns", call: (c) => c.listRuns(), method: "GET", path: "/runs" },
    {
      name: "listRuns filtered",
      call: (c) => c.listRuns({ workflowId: "wf", status: "failed", limit: 10 }),
      method: "GET",
      path: "/runs?workflowId=wf&status=failed&limit=10",
    },
    {
      name: "listRuns top-level only",
      call: (c) => c.listRuns({ topLevel: true, limit: 5 }),
      method: "GET",
      path: "/runs?topLevel=true&limit=5",
    },
    {
      name: "listRuns without stopped runs",
      call: (c) => c.listRuns({ status: "completed", stopped: false }),
      method: "GET",
      path: "/runs?status=completed&stopped=false",
    },
    { name: "getRun", call: (c) => c.getRun("r1"), method: "GET", path: "/runs/r1" },
    {
      name: "retryRun",
      call: (c) => c.retryRun("r1"),
      method: "POST",
      path: "/runs/r1/retry",
      response: { runId: "r2" },
      expected: { runId: "r2" },
    },
    {
      name: "cancelRun",
      call: (c) => c.cancelRun("r1"),
      method: "POST",
      path: "/runs/r1/cancel",
      status: 204,
      expected: undefined,
    },
    {
      name: "resumeRun",
      call: (c) => c.resumeRun("r1", { approved: true }),
      method: "POST",
      path: "/runs/r1/resume",
      body: { approved: true },
      status: 202,
      expected: undefined,
    },
    {
      name: "resumeRun at an expected step",
      call: (c) => c.resumeRun("r1", { approved: true }, { expectStep: "size/if/approval" }),
      method: "POST",
      path: "/runs/r1/resume?step=size%2Fif%2Fapproval",
      body: { approved: true },
      status: 202,
      expected: undefined,
    },
    {
      name: "resumeRun without body",
      call: (c) => c.resumeRun("r1"),
      method: "POST",
      path: "/runs/r1/resume",
      status: 202,
    },
  ];

  for (const tc of cases) {
    test(`${tc.name} → ${tc.method} ${tc.path}`, async () => {
      const { fetch, calls } = stubFetch(() =>
        tc.status === 204 || tc.status === 202
          ? new Response(null, { status: tc.status })
          : json(tc.response ?? { ok: true }, tc.status),
      );
      const client = createClient({ baseUrl: "https://api.test/flowline/", fetch });
      const result = await tc.call(client);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe(tc.method);
      expect(calls[0]!.url).toBe(`https://api.test/flowline${tc.path}`);
      expect(calls[0]!.body).toEqual(tc.body);
      // Every non-GET request declares JSON, bodyless ones too: the server refuses others (CSRF).
      if (tc.method !== "GET") expect(calls[0]!.headers["content-type"]).toBe("application/json");
      if ("expected" in tc) expect(result).toEqual(tc.expected);
    });
  }

  test("sends headers from the async headers() hook on every request", async () => {
    const { fetch, calls } = stubFetch(() => json([]));
    let n = 0;
    const client = createClient({
      baseUrl: "/flowline",
      fetch,
      headers: async () => ({ authorization: `Bearer ${++n}` }),
    });
    await client.listWorkflows();
    await client.listRuns();
    expect(calls.map((c) => c.url)).toEqual(["/flowline/workflows", "/flowline/runs"]);
    expect(calls.map((c) => c.headers.authorization)).toEqual(["Bearer 1", "Bearer 2"]);
    expect(calls[0]!.headers.accept).toBe("application/json");
  });

  test("uses the global fetch when none is given", async () => {
    const { fetch, calls } = stubFetch(() => json([]));
    vi.stubGlobal("fetch", fetch);
    try {
      await createClient({ baseUrl: "https://api.test" }).listSecrets();
      expect(calls[0]!.url).toBe("https://api.test/secrets");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("error mapping", () => {
  test("non-2xx JSON → FlowlineHttpError with status, body and server error", async () => {
    const body = { error: "workflow has errors", issues: [{ code: "ref.unresolved" }] };
    const { fetch } = stubFetch(() => json(body, 422));
    const client = createClient({ baseUrl: "https://api.test", fetch });
    const err = await client.publish("wf", 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowlineHttpError);
    expect(err).toBeInstanceOf(Error);
    const httpErr = err as FlowlineHttpError;
    expect(httpErr.status).toBe(422);
    expect(httpErr.body).toEqual(body);
    expect(httpErr.name).toBe("FlowlineHttpError");
    expect(httpErr.message).toBe("POST /workflows/wf/publish failed (422): workflow has errors");
  });

  test("non-2xx text body is kept as text", async () => {
    const { fetch } = stubFetch(() => new Response("upstream down", { status: 502 }));
    const client = createClient({ baseUrl: "https://api.test", fetch });
    const err = (await client.getRun("r1").catch((e: unknown) => e)) as FlowlineHttpError;
    expect(err.status).toBe(502);
    expect(err.body).toBe("upstream down");
    expect(err.message).toBe("GET /runs/r1 failed (502)");
  });
});

/** A streaming Response whose body yields `chunks`, then optionally stays open. */
function sseResponse(chunks: string[], opts: { keepOpen?: boolean; signal?: AbortSignal } = {}) {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      if (!opts.keepOpen) controller.close();
      opts.signal?.addEventListener("abort", () => {
        try {
          controller.error(new DOMException("aborted", "AbortError"));
        } catch {}
      });
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function frame(e: RunEvent): string {
  return `event: run\nid: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`;
}

describe("subscribeRun", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("parses SSE frames split mid-line, ignores comments, stops after a terminal event", async () => {
    const e1 = event(1, "run.started");
    const e2 = event(2);
    const e3 = event(3, "run.completed");
    const text = `: heartbeat\n\n${frame(e1)}${frame(e2).replace(/\n/g, "\r\n")}${frame(e3)}`;
    // split into awkward chunks, including mid-line and mid-CRLF
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 7) chunks.push(text.slice(i, i + 7));

    const received: RunEvent[] = [];
    let done!: () => void;
    const finished = new Promise<void>((r) => {
      done = r;
    });
    const { fetch, calls } = stubFetch((call) => {
      expect(call.url).toBe("https://api.test/runs/r1/stream");
      return sseResponse(chunks, { keepOpen: true });
    });
    const client = createClient({
      baseUrl: "https://api.test",
      fetch,
      headers: () => ({ authorization: "Bearer t" }),
    });
    client.subscribeRun("r1", (e) => {
      received.push(e);
      if (e.type === "run.completed") done();
    });
    await finished;
    expect(received).toEqual([e1, e2, e3]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toBe("Bearer t");
    expect(calls[0]!.headers.accept).toBe("text/event-stream");
  });

  test("keeps reading past a terminal event the run was retried past", async () => {
    const events = [
      event(1, "run.started"),
      event(2, "run.failed"),
      event(3, "run.resumed"),
      event(4, "run.completed"),
    ];
    const { fetch, calls } = stubFetch(() => sseResponse(events.map(frame)));
    const client = createClient({ baseUrl: "https://api.test", fetch });
    const received: RunEvent[] = [];
    client.subscribeRun("r1", (e) => received.push(e));
    await vi.waitFor(() => expect(received).toEqual(events));
    await new Promise((r) => setTimeout(r, 700));
    expect(calls).toHaveLength(1);
  });

  test("reconnects when the stream ends right after a non-terminal event", async () => {
    const e1 = event(1, "run.started");
    const e2 = event(2, "run.completed");
    let n = 0;
    const { fetch, calls } = stubFetch(() => sseResponse(n++ === 0 ? [frame(e1)] : [frame(e2)]));
    const client = createClient({ baseUrl: "https://api.test", fetch });
    const received: RunEvent[] = [];
    client.subscribeRun("r1", (e) => received.push(e));
    await vi.waitFor(() => expect(received).toEqual([e1, e2]), { timeout: 3_000 });
    expect(calls[1]?.url).toBe("https://api.test/runs/r1/stream?after=1");
  });

  test("treats run.stopped as terminal and does not reconnect", async () => {
    const e1 = event(1, "run.started");
    const e2 = event(2, "run.stopped");
    // The server closes the stream after the terminal event.
    const { fetch, calls } = stubFetch(() => sseResponse([frame(e1), frame(e2)]));
    const client = createClient({ baseUrl: "https://api.test", fetch });
    const received: RunEvent[] = [];
    client.subscribeRun("r1", (e) => received.push(e));
    await vi.waitFor(() => expect(received).toEqual([e1, e2]));
    // Past the first reconnect backoff (500 ms).
    await new Promise((r) => setTimeout(r, 700));
    expect(calls).toHaveLength(1);
  });

  test("handles CRLF split exactly between CR and LF, and ignores non-run events", async () => {
    const e1 = event(1, "run.started");
    const e2 = event(2, "run.completed");
    const crlf = (f: string) => f.replace(/\n/g, "\r\n");
    const chunks = [
      "event: run\r",
      "\nid: 1\r",
      `\ndata: ${JSON.stringify(e1)}\r`,
      "\n\r",
      "\n",
      crlf(`event: ping\ndata: ${JSON.stringify(event(99))}\n\n`),
      crlf(frame(e2)),
    ];
    const received: RunEvent[] = [];
    const { fetch } = stubFetch(() => sseResponse(chunks));
    const client = createClient({ baseUrl: "https://api.test", fetch });
    await new Promise<void>((resolve) => {
      client.subscribeRun("r1", (e) => {
        received.push(e);
        if (e.type === "run.completed") resolve();
      });
    });
    expect(received).toEqual([e1, e2]);
  });

  test("handles multi-line data fields", async () => {
    const e1 = event(1, "run.failed");
    const lines = JSON.stringify(e1, null, 2)
      .split("\n")
      .map((l) => `data: ${l}`)
      .join("\n");
    const received: RunEvent[] = [];
    const { fetch } = stubFetch(() => sseResponse([`id: 1\nevent: run\n${lines}\n\n`]));
    const client = createClient({ baseUrl: "https://api.test", fetch });
    await new Promise<void>((resolve) => {
      client.subscribeRun("r1", (e) => {
        received.push(e);
        resolve();
      });
    });
    expect(received).toEqual([e1]);
  });

  test("reconnects with ?after=<lastSeq> and exponential backoff, skipping duplicates", async () => {
    vi.useFakeTimers();
    const e1 = event(1, "run.started");
    const e2 = event(2);
    const e3 = event(3, "run.completed");
    let n = 0;
    const { fetch, calls } = stubFetch(() => {
      n++;
      if (n === 1) return sseResponse([frame(e1)]); // closes → reconnect
      if (n === 2) throw new TypeError("network down");
      if (n === 3) return new Response("busy", { status: 503 });
      return sseResponse([frame(e1), frame(e2), frame(e3)]); // e1 replayed → deduped
    });
    const received: RunEvent[] = [];
    const client = createClient({ baseUrl: "https://api.test", fetch });
    client.subscribeRun("r1", (e) => received.push(e));

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(received).toEqual([e1]);
    await vi.advanceTimersByTimeAsync(499);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); // 500ms
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); // +1000ms
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(2000); // +2000ms
    expect(calls).toHaveLength(4);
    expect(calls.slice(1).map((c) => c.url)).toEqual([
      "https://api.test/runs/r1/stream?after=1",
      "https://api.test/runs/r1/stream?after=1",
      "https://api.test/runs/r1/stream?after=1",
    ]);
    expect(received).toEqual([e1, e2, e3]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(4); // stopped after terminal event
  });

  test("backoff is capped at 10s", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = stubFetch(() => {
      throw new TypeError("down");
    });
    const unsubscribe = createClient({ baseUrl: "https://api.test", fetch }).subscribeRun(
      "r1",
      () => {},
    );
    // attempts at 0, 0.5s, 1.5s, 3.5s, 7.5s, 15.5s (delays double from 500ms), then every 10s
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500 + 1000 + 2000 + 4000 + 8000);
    expect(calls).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calls).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(7);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(8);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(8);
  });

  test("unsubscribe aborts the open stream and stops reconnecting", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const calls: string[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      signal = init?.signal ?? undefined;
      return sseResponse([frame(event(1, "run.started"))], {
        keepOpen: true,
        signal: init?.signal ?? undefined,
      });
    }) as typeof globalThis.fetch;
    const received: RunEvent[] = [];
    const unsubscribe = createClient({ baseUrl: "https://api.test", fetch }).subscribeRun(
      "r1",
      (e) => received.push(e),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toHaveLength(1);
    unsubscribe();
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
  });

  test("stops on non-retryable 4xx responses", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = stubFetch(() => json({ error: "not found" }, 404));
    createClient({ baseUrl: "https://api.test", fetch }).subscribeRun("r1", () => {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
  });

  test("falls back to polling getRun every 2s when streaming is unsupported", async () => {
    vi.useFakeTimers();
    const e1 = event(1, "run.started");
    const e2 = event(2);
    const e3 = event(3, "run.completed");
    const snapshots = [[e1], [e1, e2], [e1, e2, e3]];
    let polls = 0;
    const { fetch, calls } = stubFetch((call) => {
      if (call.url.endsWith("/stream")) {
        // A response without a readable body (e.g. old React Native fetch).
        const res = new Response(null, { status: 200 });
        Object.defineProperty(res, "body", { value: null });
        return res;
      }
      const events = snapshots[Math.min(polls++, snapshots.length - 1)];
      return json({ run: { id: "r1" }, events, doc });
    });
    const received: RunEvent[] = [];
    createClient({ baseUrl: "https://api.test", fetch }).subscribeRun("r1", (e) =>
      received.push(e),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual([e1]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(received).toEqual([e1, e2]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(received).toEqual([e1, e2, e3]);
    const count = calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(count); // stopped after terminal event
    expect(calls.slice(1).every((c) => c.url === "https://api.test/runs/r1")).toBe(true);
  });
});
