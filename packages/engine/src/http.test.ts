import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createRegistry,
  defineNode,
  definePlugin,
  defineTrigger,
  type WorkflowDoc,
} from "@flowkit/core";
import { isPrivateAddress } from "@flowkit/nodes-builtin/ssrf";
import { createMemoryStorage } from "@flowkit/storage-memory";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createNodeContext } from "./context";
import { createEngine, type EngineOptions } from "./engine";
import { createGuardedFetch, type GuardedFetchOptions, type Resolver } from "./http";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let port: number;
let hits: string[];
let received: IncomingMessage["headers"][];
let handler: Handler;

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(`${req.method} ${req.headers.host} ${req.url}`);
    received.push(req.headers);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  hits = [];
  received = [];
  handler = (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  };
});

/** A resolver answering from a fixed table, counting calls per hostname. */
function tableResolver(table: Record<string, string[] | (() => string[])>) {
  const calls: Record<string, number> = {};
  const resolve: Resolver = async (hostname) => {
    calls[hostname] = (calls[hostname] ?? 0) + 1;
    const entry = table[hostname];
    if (!entry) throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    const list = typeof entry === "function" ? entry() : entry;
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return { resolve, calls };
}

/** Treats the loopback test server as "public" so redirect and rebinding hops can be observed. */
const loopbackIsPublic = (ip: string) => ip !== "127.0.0.1" && isPrivateAddress(ip);

function ctxWith(opts: GuardedFetchOptions = {}) {
  return createNodeContext({
    runId: "r1",
    tenantId: "t1",
    workflowId: "wf",
    stepId: "s1",
    stepPath: "s1",
    attempt: 1,
    idempotencyKey: "k",
    services: {},
    signal: new AbortController().signal,
    clock: () => 0,
    scope: { trigger: {}, steps: {}, run: { id: "r1" } },
    http: createGuardedFetch(opts),
  });
}

async function fatal(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(
    () => {
      throw new Error("expected rejection");
    },
    (e: unknown) => e as Error,
  );
  expect(err.name).toBe("FatalError");
  return err;
}

describe("ctx.http.fetch SSRF guard", () => {
  it("blocks loopback by default without connecting", async () => {
    const err = await fatal(ctxWith().http.fetch(`http://127.0.0.1:${port}/`));
    expect(err.message).toContain("blocked private network address");
    expect(hits).toEqual([]);
  });

  it("allows private networks when configured", async () => {
    const res = await ctxWith({ allowPrivateNetworks: true }).http.fetch(
      `http://127.0.0.1:${port}/x`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(hits).toEqual([`GET 127.0.0.1:${port} /x`]);
  });

  it.each(["http://localhost/", "http://LOCALHOST./", "http://api.localhost/"])(
    "blocks %s",
    async (url) => {
      const err = await fatal(ctxWith().http.fetch(url));
      expect(err.message).toContain("blocked private network address");
    },
  );

  it("blocks a hostname that resolves to loopback", async () => {
    const { resolve } = tableResolver({ "evil.test": ["93.184.216.34", "127.0.0.1"] });
    const logged: unknown[] = [];
    const logger = {
      debug() {},
      info() {},
      error() {},
      warn: (message: string, data?: unknown) => logged.push({ message, data }),
    };
    const err = await fatal(ctxWith({ resolve, logger }).http.fetch("http://evil.test/"));
    expect(err.message).toBe("blocked private network address: evil.test");
    expect(err.message).not.toContain("127.0.0.1");
    expect(logged).toEqual([
      {
        message: expect.stringContaining("blocked"),
        data: { host: "evil.test", address: "127.0.0.1" },
      },
    ]);
  });

  it("aborts a hanging DNS lookup with the request signal", async () => {
    const resolve: Resolver = () => new Promise(() => {});
    const started = Date.now();
    const err = await ctxWith({ resolve })
      .http.fetch("http://slow.test/", { signal: AbortSignal.timeout(50) })
      .catch((e: Error) => e);
    expect((err as Error).name).toBe("TimeoutError");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("bounds the wait for response headers by timeoutMs", async () => {
    handler = () => {};
    const started = Date.now();
    const err = await ctxWith({ allowPrivateNetworks: true })
      .http.fetch(`http://127.0.0.1:${port}/`, { timeoutMs: 200 })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it.each([
    "http://2130706433/",
    "http://0x7f.1/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://127.1/",
    "http://0/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[0:0:0:0:0:ffff:a9fe:a9fe]/",
    "http://[fe80::1]/",
    "http://[fd00::1]/",
  ])("blocks the literal address in %s", async (url) => {
    const err = await fatal(ctxWith().http.fetch(url));
    expect(err.message).toContain("blocked private network address");
  });

  it.each([
    "file:///etc/passwd",
    "ftp://example.com/",
    "data:text/plain,hello",
    "javascript:alert(1)",
    "gopher://example.com/",
  ])("rejects the unsupported scheme of %s", async (url) => {
    const err = await fatal(ctxWith({ allowPrivateNetworks: true }).http.fetch(url));
    expect(err.message).toContain("unsupported URL scheme");
  });

  it("rejects invalid URLs and URLs with credentials", async () => {
    expect((await fatal(ctxWith().http.fetch("not a url"))).message).toContain("invalid URL");
    const err = await fatal(
      ctxWith({ allowPrivateNetworks: true }).http.fetch(`http://u:p@127.0.0.1:${port}/`),
    );
    expect(err.message).toContain("credentials");
  });

  it("enforces allowHosts", async () => {
    const { resolve } = tableResolver({ "api.test": ["127.0.0.1"], "other.test": ["127.0.0.1"] });
    const ctx = ctxWith({ resolve, allowPrivateNetworks: true, allowHosts: ["API.test"] });
    const res = await ctx.http.fetch(`http://api.test:${port}/`);
    expect(res.status).toBe(200);
    const err = await fatal(ctx.http.fetch(`http://other.test:${port}/`));
    expect(err.message).toContain("not in the allowed hosts");
    expect(hits).toHaveLength(1);
  });

  it("reports DNS failures as retryable", async () => {
    const { resolve } = tableResolver({});
    const err = await ctxWith({ resolve })
      .http.fetch("http://missing.test/")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("RetryableError");
  });
});

describe("DNS rebinding", () => {
  it("connects to the address it checked, not to a later answer", async () => {
    // First answer: the test server (treated as public). Any later answer: a private address.
    let n = 0;
    const { resolve, calls } = tableResolver({
      "rebind.test": () => (n++ === 0 ? ["127.0.0.1"] : ["10.13.13.13"]),
    });
    const ctx = ctxWith({ resolve, isPrivate: loopbackIsPublic });
    const res = await ctx.http.fetch(`http://rebind.test:${port}/data`);
    expect(res.status).toBe(200);
    expect(hits).toEqual([`GET rebind.test:${port} /data`]);
    expect(calls["rebind.test"]).toBe(1);
  });

  it("re-checks every redirect hop against a fresh resolution", async () => {
    let n = 0;
    const { resolve } = tableResolver({
      "rebind.test": () => (n++ === 0 ? ["127.0.0.1"] : ["10.13.13.13"]),
    });
    handler = (req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/next" });
        res.end();
        return;
      }
      res.end("reached");
    };
    const err = await fatal(
      ctxWith({ resolve, isPrivate: loopbackIsPublic }).http.fetch(
        `http://rebind.test:${port}/start`,
      ),
    );
    expect(err.message).toContain("blocked private network address");
    expect(hits).toEqual([`GET rebind.test:${port} /start`]);
  });
});

describe("redirects", () => {
  const { resolve } = tableResolver({
    "public.test": ["127.0.0.1"],
    "internal.test": ["10.0.0.5"],
  });
  const ctx = () => ctxWith({ resolve, isPrivate: loopbackIsPublic });

  it.each([
    "http://169.254.169.254/latest/meta-data",
    "http://internal.test/",
    "http://localhost/",
    "http://[::1]/",
    "file:///etc/passwd",
  ])("blocks a redirect to %s", async (location) => {
    handler = (_req, res) => {
      res.writeHead(302, { location });
      res.end();
    };
    const err = await fatal(ctx().http.fetch(`http://public.test:${port}/`));
    expect(err.message).toMatch(/blocked private network address|unsupported URL scheme/);
    expect(hits).toHaveLength(1);
  });

  it("follows allowed redirects, switching to GET on 303", async () => {
    handler = (req, res) => {
      if (req.url === "/a") {
        res.writeHead(303, { location: "/b" });
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ at: req.url, method: req.method }));
    };
    const res = await ctx().http.fetch(`http://public.test:${port}/a`, {
      method: "POST",
      body: "x",
    });
    expect(await res.json()).toEqual({ at: "/b", method: "GET" });
  });

  const sent = {
    Authorization: "Bearer tok",
    "X-Auth-Token": "custom-auth",
    "X-Api-Key": "key-123",
    Cookie: "sid=1",
    Accept: "application/json",
    "Accept-Language": "en",
    "User-Agent": "flowkit-test",
    "Idempotency-Key": "idem-1",
  };

  it("strips all but safelisted headers on a cross-origin redirect", async () => {
    const { resolve: r2 } = tableResolver({
      "public.test": ["127.0.0.1"],
      "other.test": ["127.0.0.1"],
    });
    handler = (req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: `http://other.test:${port}/land` });
        res.end();
        return;
      }
      res.end("ok");
    };
    await ctxWith({ resolve: r2, isPrivate: loopbackIsPublic }).http.fetch(
      `http://public.test:${port}/start`,
      { headers: sent },
    );
    expect(hits).toEqual([`GET public.test:${port} /start`, `GET other.test:${port} /land`]);
    const landed = received[1] ?? {};
    for (const h of ["authorization", "x-auth-token", "x-api-key", "cookie"]) {
      expect(landed[h]).toBeUndefined();
    }
    expect(landed).toMatchObject({
      accept: "application/json",
      "accept-language": "en",
      "user-agent": "flowkit-test",
      "idempotency-key": "idem-1",
    });
  });

  it("strips credentialHeaders on a cross-origin redirect, even safelisted ones", async () => {
    const { resolve: r2 } = tableResolver({
      "public.test": ["127.0.0.1"],
      "other.test": ["127.0.0.1"],
    });
    handler = (req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: `http://other.test:${port}/land` });
        res.end();
        return;
      }
      res.end("ok");
    };
    await ctxWith({ resolve: r2, isPrivate: loopbackIsPublic }).http.fetch(
      `http://public.test:${port}/start`,
      {
        headers: { Accept: "secret-accept", "Idempotency-Key": "secret-key", "User-Agent": "ua" },
        credentialHeaders: ["accept", "IDEMPOTENCY-KEY"],
      } as RequestInit,
    );
    expect(received[0]).toMatchObject({ accept: "secret-accept", "idempotency-key": "secret-key" });
    const landed = received[1] ?? {};
    // undici adds its default `accept: */*` when none is sent.
    expect(landed.accept).toBe("*/*");
    expect(landed["idempotency-key"]).toBeUndefined();
    expect(JSON.stringify(landed)).not.toContain("secret-");
    expect(landed["user-agent"]).toBe("ua");
  });

  it("keeps headers on a same-origin redirect", async () => {
    handler = (req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/land" });
        res.end();
        return;
      }
      res.end("ok");
    };
    await ctx().http.fetch(`http://public.test:${port}/start`, { headers: sent });
    expect(received[1]).toMatchObject({
      authorization: "Bearer tok",
      "x-auth-token": "custom-auth",
      "x-api-key": "key-123",
      cookie: "sid=1",
    });
  });

  it("preserves method and body on 307", async () => {
    handler = (req, res) => {
      if (req.url === "/a") {
        res.writeHead(307, { location: "/b" });
        res.end();
        return;
      }
      let body = "";
      req.on("data", (c: Buffer) => {
        body += c.toString();
      });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ method: req.method, body, type: req.headers["content-type"] }));
      });
    };
    const res = await ctx().http.fetch(`http://public.test:${port}/a`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "payload",
    });
    expect(await res.json()).toEqual({ method: "POST", body: "payload", type: "text/plain" });
  });

  describe("with init.redirect", () => {
    const redirectElsewhere = () => {
      handler = (req, res) => {
        if (req.url === "/a") {
          res.writeHead(307, { location: `http://other.test:${port}/b` });
          res.end();
          return;
        }
        res.end("followed");
      };
    };
    const post = { method: "POST", body: "resume-url-inside" } as const;
    const other = () =>
      ctxWith({
        resolve: tableResolver({ "public.test": ["127.0.0.1"], "other.test": ["127.0.0.1"] })
          .resolve,
        isPrivate: loopbackIsPublic,
      });

    it('"error" fails on a redirect without re-sending the body', async () => {
      redirectElsewhere();
      const err = await fatal(
        other().http.fetch(`http://public.test:${port}/a`, { ...post, redirect: "error" }),
      );
      expect(err.message).toBe("redirects are not allowed");
      expect(hits).toHaveLength(1);
    });

    it('"manual" returns the redirect response as is', async () => {
      redirectElsewhere();
      const res = await other().http.fetch(`http://public.test:${port}/a`, {
        ...post,
        redirect: "manual",
      });
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe(`http://other.test:${port}/b`);
      expect(hits).toHaveLength(1);
    });
  });

  it("gives up after 5 redirects", async () => {
    handler = (req, res) => {
      const n = Number(req.url?.slice(1) ?? 0);
      res.writeHead(302, { location: `/${n + 1}` });
      res.end();
    };
    const err = await fatal(ctx().http.fetch(`http://public.test:${port}/0`));
    expect(err.message).toContain("too many redirects");
    expect(hits).toHaveLength(6);
  });
});

describe("response size limit", () => {
  it("fails a body larger than maxResponseBytes", async () => {
    handler = (_req, res) => {
      res.write("a".repeat(1500));
      res.end("b".repeat(1500));
    };
    const err = await fatal(
      ctxWith({ allowPrivateNetworks: true, maxResponseBytes: 2000 }).http.fetch(
        `http://127.0.0.1:${port}/`,
      ),
    );
    expect(err.message).toContain("exceeds 2000 bytes");
  });

  it("fails early on a large Content-Length", async () => {
    handler = (_req, res) => {
      res.setHeader("content-length", "5000");
      res.end("x".repeat(5000));
    };
    const err = await fatal(
      ctxWith({ allowPrivateNetworks: true, maxResponseBytes: 2000 }).http.fetch(
        `http://127.0.0.1:${port}/`,
      ),
    );
    expect(err.message).toContain("exceeds 2000 bytes");
  });

  it("returns bodies within the limit", async () => {
    handler = (_req, res) => res.end("z".repeat(2000));
    const res = await ctxWith({ allowPrivateNetworks: true, maxResponseBytes: 2000 }).http.fetch(
      `http://127.0.0.1:${port}/`,
    );
    expect((await res.text()).length).toBe(2000);
  });
});

describe("engine wiring", () => {
  const registry = createRegistry([
    definePlugin({
      id: "t",
      name: "Test",
      triggers: [
        defineTrigger({ type: "t.manual", name: "Manual", kind: "manual", config: z.object({}) }),
      ],
      nodes: [
        defineNode({
          type: "t.get",
          name: "Get",
          input: z.object({ url: z.string() }),
          retry: { max: 1 },
          run: async ({ input, ctx }) => ({ body: await (await ctx.http.fetch(input.url)).json() }),
        }),
        defineNode({
          type: "t.code",
          name: "Code",
          input: z.object({ code: z.string() }),
          run: ({ input, ctx }) =>
            ctx.transform.run(input.code, ctx.scope, { timeoutMs: 1000, memoryBytes: 1 << 24 }),
        }),
      ],
    }),
  ]);

  async function runStep(
    type: string,
    config: Record<string, string>,
    http?: EngineOptions["http"],
  ) {
    const storage = createMemoryStorage();
    const doc: WorkflowDoc = {
      id: "wf",
      name: "Workflow",
      trigger: { type: "t.manual", config: {} },
      steps: [{ id: "s", type, config }],
    };
    const v = await storage.saveWorkflowVersion("t1", doc, "user", 1);
    await storage.publishVersion("t1", doc.id, v.version, 1);
    await storage.createRun(
      {
        id: "run-1",
        tenantId: "t1",
        workflowId: doc.id,
        version: v.version,
        status: "queued",
        trigger: { n: 21 },
        journal: {},
        attempt: 1,
        startedBy: { kind: "manual" },
      },
      [{ runId: "run-1", tenantId: "t1", type: "run.started", at: 1 }],
      1,
    );
    await createEngine({ registry, storage, ...(http ? { http } : {}) }).drain();
    return storage.getRun("t1", "run-1");
  }

  it("blocks private networks by default", async () => {
    const run = await runStep("t.get", { url: `http://127.0.0.1:${port}/` });
    expect(run?.status).toBe("failed");
    expect(run?.error?.message).toContain("blocked private network address");
    expect(hits).toEqual([]);
  });

  it("applies EngineOptions.http", async () => {
    const run = await runStep(
      "t.get",
      { url: `http://127.0.0.1:${port}/` },
      { allowPrivateNetworks: true },
    );
    expect(run?.status).toBe("completed");
    expect(run?.journal.s).toMatchObject({ status: "done", output: { body: { ok: true } } });
  });

  it("runs ctx.transform on QuickJS by default", async () => {
    const run = await runStep("t.code", { code: "return { doubled: trigger.n * 2 };" });
    expect(run?.status).toBe("completed");
    expect(run?.journal.s).toMatchObject({ status: "done", output: { doubled: 42 } });
  });
});

describe("core.httpRequest auth end to end", () => {
  it("sends the secret on the wire but keeps it out of output, journal and events", async () => {
    // core.httpRequest and core.manual come from the built-ins createEngine registers.
    const registry = createRegistry([]);
    const storage = createMemoryStorage();
    const doc: WorkflowDoc = {
      id: "wf",
      name: "Workflow",
      trigger: { type: "core.manual", config: {} },
      steps: [
        {
          id: "call",
          type: "core.httpRequest",
          config: {
            method: "GET",
            url: `http://127.0.0.1:${port}/`,
            headers: { "X-Trace": "trace-1" },
            auth: { type: "bearer", secret: "apiToken" },
          },
        },
      ],
    };
    const v = await storage.saveWorkflowVersion("t1", doc, "user", 1);
    await storage.publishVersion("t1", doc.id, v.version, 1);
    await storage.createRun(
      {
        id: "run-1",
        tenantId: "t1",
        workflowId: doc.id,
        version: v.version,
        status: "queued",
        trigger: {},
        journal: {},
        attempt: 1,
        startedBy: { kind: "manual" },
      },
      [{ runId: "run-1", tenantId: "t1", type: "run.started", at: 1 }],
      1,
    );
    const emitted: unknown[] = [];
    await createEngine({
      registry,
      storage,
      http: { allowPrivateNetworks: true },
      secrets: { get: async (_t, name) => (name === "apiToken" ? "tok-s3cr3t" : undefined) },
      onEvent: (e) => emitted.push(e),
    }).drain();

    expect(received[0]?.authorization).toBe("Bearer tok-s3cr3t");
    const run = await storage.getRun("t1", "run-1");
    expect(run?.status).toBe("completed");
    expect(run?.journal.call).toMatchObject({ status: "done", output: { status: 200 } });
    const events = await storage.listEvents("t1", "run-1");
    expect(emitted.length).toBeGreaterThan(0);
    for (const blob of [run, events, emitted]) {
      expect(JSON.stringify(blob)).not.toContain("tok-s3cr3t");
    }
    // Sensitive headers are masked in events (the journal keeps them for downstream references).
    expect(JSON.stringify(events)).not.toContain("trace-1");
    expect(JSON.stringify(emitted)).not.toContain("trace-1");
  });
});
