import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createRegistry,
  definePlugin,
  defineTrigger,
  FatalError,
  type NodeContext,
  UI_META_KEY,
  validateWorkflow,
} from "@flowlinejs/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { httpRequest } from "./http";

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let server: Server;
let base: string;
let seen: Seen[];
let respond: (req: IncomingMessage, res: ServerResponse) => void;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      respond(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  respond = (_req, res) => {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("x-request-id", "abc");
    res.end(JSON.stringify({ id: 7, name: "Ada" }));
  };
});

const SECRETS: Record<string, string> = {
  token: "tok-s3cr3t",
  login: "ada:pässword",
  apiKey: "key-s3cr3t",
  broken: "bad\nvalue",
};

/** A context whose `http.fetch` is plain `fetch` (the equivalent of `allowPrivateNetworks`). */
function ctx(overrides: Partial<NodeContext> = {}): NodeContext {
  return {
    idempotencyKey: "idem-123",
    signal: new AbortController().signal,
    http: { fetch: (url: string, init?: RequestInit) => fetch(url, init) },
    secrets: {
      async get(name: string) {
        const value = SECRETS[name];
        if (value === undefined) throw new FatalError(`Secret "${name}" is not configured`);
        return value;
      },
    },
    ...overrides,
  } as NodeContext;
}

interface Output {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

async function run(config: Record<string, unknown>, c: NodeContext = ctx()): Promise<Output> {
  const input = httpRequest.input.parse(config);
  return (await httpRequest.run({ input, ctx: c })) as Output;
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  return p.then(
    () => {
      throw new Error("expected rejection");
    },
    (e: unknown) => e as Error,
  );
}

describe("core.httpRequest", () => {
  it("GETs JSON with query parameters and the idempotency key", async () => {
    const out = await run({ method: "GET", url: `${base}/contacts?x=1`, query: { q: "a b" } });
    expect(out).toEqual({
      status: 200,
      headers: expect.objectContaining({
        "content-type": "application/json; charset=utf-8",
        "x-request-id": "abc",
      }),
      body: { id: 7, name: "Ada" },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.url).toBe("/contacts?x=1&q=a+b");
    expect(seen[0]?.headers["idempotency-key"]).toBe("idem-123");
  });

  it("POSTs a JSON body with custom headers", async () => {
    await run({
      method: "POST",
      url: `${base}/contacts`,
      headers: { Authorization: "Bearer s3cret" },
      bodyType: "json",
      body: { name: "Ada" },
    });
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.headers["content-type"]).toBe("application/json");
    expect(seen[0]?.headers.authorization).toBe("Bearer s3cret");
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({ name: "Ada" });
  });

  it("sends form and text bodies", async () => {
    await run({ method: "PUT", url: base, bodyType: "form", body: { a: "1", b: "x y" } });
    expect(seen[0]?.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded;charset=UTF-8",
    );
    expect(seen[0]?.body).toBe("a=1&b=x+y");
    await run({ method: "PATCH", url: base, bodyType: "text", body: "hello" });
    expect(seen[1]?.headers["content-type"]).toBe("text/plain;charset=UTF-8");
    expect(seen[1]?.body).toBe("hello");
  });

  it("does not echo request headers into the output", async () => {
    const out = await run({ method: "GET", url: base, headers: { "X-Api-Key": "s3cret" } });
    expect(JSON.stringify(out)).not.toContain("s3cret");
  });

  it("can omit the idempotency key, and keeps a caller-provided one", async () => {
    await run({ method: "GET", url: base, sendIdempotencyKey: false });
    expect(seen[0]?.headers["idempotency-key"]).toBeUndefined();
    await run({ method: "GET", url: base, headers: { "Idempotency-Key": "mine" } });
    expect(seen[1]?.headers["idempotency-key"]).toBe("mine");
  });

  it("returns non-JSON bodies as text", async () => {
    respond = (_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<p>hi</p>");
    };
    expect((await run({ method: "GET", url: base })).body).toBe("<p>hi</p>");
  });

  it.each([500, 503, 429])("treats %i as retryable", async (status) => {
    respond = (_req, res) => {
      res.statusCode = status;
      res.end("nope");
    };
    const err = await rejection(run({ method: "GET", url: base }));
    expect(err.name).toBe("RetryableError");
    expect(err.message).toContain(`HTTP ${status}`);
  });

  it("treats 404 as fatal", async () => {
    respond = (_req, res) => {
      res.statusCode = 404;
      res.end("missing");
    };
    const err = await rejection(run({ method: "GET", url: base }));
    expect(err.name).toBe("FatalError");
    expect(err.message).toContain("HTTP 404");
  });

  it("returns 4xx responses when failOnHttpError is false", async () => {
    respond = (_req, res) => {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "missing" }));
    };
    const out = await run({ method: "GET", url: base, failOnHttpError: false });
    expect(out).toMatchObject({ status: 404, body: { error: "missing" } });
  });

  it("treats network errors as retryable", async () => {
    const err = await rejection(run({ method: "GET", url: "http://127.0.0.1:1/" }));
    expect(err.name).toBe("RetryableError");
  });

  it("passes guard rejections through unchanged", async () => {
    const blocked = Object.assign(new Error("blocked private network address: 127.0.0.1"), {
      name: "FatalError",
    });
    const c = ctx({ http: { fetch: () => Promise.reject(blocked) } });
    expect(await rejection(run({ method: "GET", url: "http://127.0.0.1/" }, c))).toBe(blocked);
  });

  it("times out after timeoutMs", async () => {
    respond = () => {};
    const started = Date.now();
    const err = await rejection(run({ method: "GET", url: base, timeoutMs: 100 }));
    expect(err.name).toBe("RetryableError");
    expect(err.message).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("rejects a body on GET", async () => {
    const err = await rejection(run({ method: "GET", url: base, bodyType: "json", body: {} }));
    expect(err.name).toBe("FatalError");
  });

  describe("auth", () => {
    it("sends a bearer token from a secret, overriding headers", async () => {
      const out = await run({
        method: "GET",
        url: base,
        headers: { Authorization: "Bearer from-headers" },
        auth: { type: "bearer", secret: "token" },
      });
      expect(seen[0]?.headers.authorization).toBe("Bearer tok-s3cr3t");
      expect(JSON.stringify(out)).not.toContain("tok-s3cr3t");
    });

    it("sends basic auth as base64 of the user:password secret", async () => {
      await run({ method: "GET", url: base, auth: { type: "basic", secret: "login" } });
      const header = seen[0]?.headers.authorization ?? "";
      expect(header.startsWith("Basic ")).toBe(true);
      expect(Buffer.from(header.slice(6), "base64").toString("utf8")).toBe("ada:pässword");
    });

    it("sends a custom header, overriding a same-named one from headers", async () => {
      await run({
        method: "GET",
        url: base,
        headers: { "x-api-key": "from-headers" },
        auth: { type: "header", secret: "apiKey", headerName: "X-Api-Key" },
      });
      expect(seen[0]?.headers["x-api-key"]).toBe("key-s3cr3t");
    });

    it.each([
      [{ type: "none" }, []],
      [{ type: "bearer", secret: "token" }, ["authorization"]],
      [{ type: "basic", secret: "login" }, ["authorization"]],
      [{ type: "header", secret: "apiKey", headerName: "Accept" }, ["accept"]],
    ])("marks the %o auth header as a credential for redirects", async (auth, expected) => {
      let init: (RequestInit & { credentialHeaders?: string[] }) | undefined;
      const c = ctx({
        http: {
          fetch: (url: string, i?: RequestInit) => {
            init = i;
            return fetch(url, i);
          },
        },
      });
      await run({ method: "GET", url: base, auth }, c);
      expect(init?.credentialHeaders ?? []).toEqual(expected);
    });

    it("fails fatally when the secret is not configured, without sending", async () => {
      const err = await rejection(
        run({ method: "GET", url: base, auth: { type: "bearer", secret: "missing" } }),
      );
      expect(err.name).toBe("FatalError");
      expect(err.message).toContain('"missing"');
      expect(seen).toEqual([]);
    });

    it("never puts the secret value in an error", async () => {
      const err = await rejection(
        run({ method: "GET", url: base, auth: { type: "bearer", secret: "broken" } }),
      );
      expect(err.name).toBe("FatalError");
      expect(err.message).not.toContain("bad");
      expect(seen).toEqual([]);
    });

    it("requires secret and headerName in the schema", () => {
      const parse = (auth: unknown) =>
        httpRequest.input.safeParse({ method: "GET", url: base, auth }).success;
      expect(parse({ type: "none" })).toBe(true);
      expect(parse({ type: "bearer" })).toBe(false);
      expect(parse({ type: "basic", secret: "" })).toBe(false);
      expect(parse({ type: "header", secret: "apiKey" })).toBe(false);
      expect(parse({ type: "header", secret: "apiKey", headerName: "bad name" })).toBe(false);
      expect(parse({ type: "header", secret: "apiKey", headerName: "X-Key" })).toBe(true);
      expect(httpRequest.input.parse({ method: "GET", url: base }).auth).toEqual({ type: "none" });
    });

    it("re-checks auth at runtime when the input was not validated", async () => {
      const input = httpRequest.input.parse({ method: "GET", url: base });
      const unchecked = { ...input, auth: { type: "header", secret: "apiKey" } } as never;
      const err = await rejection(
        Promise.resolve(httpRequest.run({ input: unchecked, ctx: ctx() })),
      );
      expect(err.name).toBe("FatalError");
      expect(seen).toEqual([]);
    });

    it("lets the validator report missing auth fields", () => {
      const manifest = createRegistry([
        definePlugin({
          id: "core",
          name: "Core",
          nodes: [httpRequest],
          triggers: [
            defineTrigger({ type: "core.manual", name: "M", kind: "manual", config: z.object({}) }),
          ],
        }),
      ]).manifest();
      const doc = (auth: unknown) => ({
        id: "wf",
        name: "W",
        trigger: { type: "core.manual", config: {} },
        steps: [
          { id: "call", type: "core.httpRequest", config: { method: "GET", url: base, auth } },
        ],
      });
      const issuesFor = (auth: unknown) =>
        // The test server is on loopback, which this engine allows.
        validateWorkflow(doc(auth) as never, manifest, {
          network: { allowPrivateNetworks: true },
        }).filter((i) => i.stepId === "call");
      expect(issuesFor({ type: "bearer", secret: "token" })).toEqual([]);
      expect(issuesFor({ type: "bearer" })).not.toEqual([]);
      expect(issuesFor({ type: "header", secret: "apiKey" })).not.toEqual([]);
    });

    it("marks auth.secret as a secret name in the manifest", () => {
      const manifest = createRegistry([
        definePlugin({ id: "core", name: "Core", nodes: [httpRequest] }),
      ]).manifest();
      const node = manifest.nodes.find((n) => n.type === "core.httpRequest");
      expect(JSON.stringify(node?.input)).toContain('"secret":true');
    });
  });

  it("marks headers as sensitive in the manifest", () => {
    const registry = createRegistry([
      definePlugin({ id: "core", name: "Core", nodes: [httpRequest] }),
    ]);
    const node = registry.manifest().nodes.find((n) => n.type === "core.httpRequest");
    const input = node?.input as
      | { properties?: Record<string, Record<string, unknown>> }
      | undefined;
    const headers = input?.properties?.headers;
    expect(headers?.[UI_META_KEY]).toMatchObject({ sensitive: true });
  });
});
