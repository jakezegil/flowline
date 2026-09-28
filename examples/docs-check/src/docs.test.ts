/**
 * Keeps the docs honest: every TypeScript block in README.md and the plugin guide is extracted
 * (see `extract.ts`), typechecked against the real packages, and the README quick start is run
 * end to end, with memory storage standing in for Postgres and no port opened.
 */
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Engine } from "@flowline/engine";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { extractBlocks } from "./extract";

vi.mock("pg", () => ({ default: { Pool: class {} } }));
vi.mock("@flowline/storage-postgres", async () => {
  const { createMemoryStorage } = await import("@flowline/storage-memory");
  return { migrate: async () => {}, createPostgresStorage: () => createMemoryStorage() };
});
vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const REPO = join(PKG, "../..");
const OUT = join(PKG, ".generated");
const DOCS = { readme: "README.md", guide: "docs/guides/writing-a-plugin.md" } as const;
type Project = keyof typeof DOCS;

const unannotated: string[] = [];

/** Write one document's blocks plus its stubs into `.generated/<project>` with a tsconfig. */
function generate(project: Project): void {
  const dir = join(OUT, project);
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(PKG, "stubs", project), dir, { recursive: true });
  const { blocks, unannotated: lines } = extractBlocks(
    readFileSync(join(REPO, DOCS[project]), "utf8"),
  );
  unannotated.push(...lines.map((l) => `${DOCS[project]}:${l}`));
  const seen = new Set<string>();
  for (const b of blocks) {
    if (seen.has(b.file)) throw new Error(`${DOCS[project]}:${b.line}: duplicate file=${b.file}`);
    seen.add(b.file);
    mkdirSync(dirname(join(dir, b.file)), { recursive: true });
    writeFileSync(join(dir, b.file), b.code);
  }
  const tsconfig = {
    extends: join(REPO, "tsconfig.base.json"),
    compilerOptions: { types: ["node"] },
    include: ["**/*"],
  };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
}

const tscBin = createRequire(import.meta.url).resolve("typescript/bin/tsc");
async function typecheck(project: Project): Promise<string> {
  try {
    await promisify(execFile)(process.execPath, [tscBin, "-p", join(OUT, project)]);
    return "";
  } catch (err) {
    return (err as { stdout?: string }).stdout || String(err);
  }
}

const load = (file: string) => import(pathToFileURL(join(OUT, "readme", file)).href);

/** The Hono app server.ts passes to (mocked) `serve`. */
type HonoApp = { fetch(req: Request): Promise<Response> };
let app: HonoApp;

beforeAll(async () => {
  generate("readme");
  generate("guide");
  // Mount the README's server once, so every test can call the handler on its own.
  await load("server.ts");
  const { serve } = await import("@hono/node-server");
  app = vi.mocked(serve).mock.calls[0]?.[0] as HonoApp;
}, 30_000);

describe("docs", () => {
  it("annotates every TypeScript block with file= (or nocheck)", () => {
    expect(unannotated).toEqual([]);
  });

  it("typechecks the README and plugin guide snippets", async () => {
    const [readme, guide] = await Promise.all([typecheck("readme"), typecheck("guide")]);
    expect(readme).toBe("");
    expect(guide).toBe("");
  }, 60_000);

  it("runs the README quick start to a completed run", async () => {
    const { engine } = (await load("flowline/engine.ts")) as { engine: Engine };
    await load("app.ts"); // publishes welcome-contact and emits contact.created
    const { worker } = (await load("worker.ts")) as { worker: { stop(): Promise<void> } };
    try {
      await vi.waitFor(
        async () => {
          const [run] = await engine.storage.listRuns("acme", {});
          expect(run?.status).toBe("completed");
        },
        { timeout: 5_000, interval: 25 },
      );
    } finally {
      await worker.stop();
    }

    // Through the mounted HTTP handler, as the editor and run viewer see it.
    const res = await app.fetch(new Request("http://localhost/flowline/runs"));
    expect(res.status).toBe(200);
    const runs = (await res.json()) as { id: string; workflowId: string; status: string }[];
    expect(runs).toMatchObject([{ workflowId: "welcome-contact", status: "completed" }]);
    const detail = await engine.getRunDetail("acme", runs[0]!.id);
    expect(detail?.run.journal.contact).toMatchObject({
      status: "done",
      output: { id: "c_42", name: "Ada" },
    });
  }, 20_000);

  it("publishes the tree-model sample against the quick-start engine", async () => {
    const { engine } = (await load("flowline/engine.ts")) as { engine: Engine };
    await load("flowline/welcome-vip.ts"); // saves and publishes, throwing if invalid
    const detail = await engine.storage.getPublishedVersion("acme", "welcome-vip");
    expect(detail?.doc.steps.map((s) => s.id)).toEqual(["contact", "check", "refresh"]);
  });

  it("calls the README's signed webhook through the mounted handler", async () => {
    const { engine } = (await load("flowline/engine.ts")) as { engine: Engine };
    const { publishLeadWebhook, signedRequest } = (await load("flowline/webhook.ts")) as {
      publishLeadWebhook(tenantId: string): Promise<string>;
      signedRequest(url: string, key: string, requestId: string): Request;
    };
    const { WEBHOOK_KEY } = (await load("vault.ts")) as { WEBHOOK_KEY: string };

    const url = await publishLeadWebhook("acme");
    expect(url).toMatch(/^https:\/\/app\.example\.com\/flowline\/hooks\/acme\/lead-received\/\S+$/);

    const first = await app.fetch(signedRequest(url, WEBHOOK_KEY, "req-1"));
    expect(first.status).toBe(202);
    const { runId } = (await first.json()) as { runId: string };

    const repeat = await app.fetch(signedRequest(url, WEBHOOK_KEY, "req-1"));
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ runId, deduped: true });

    const forged = await app.fetch(signedRequest(url, "not-the-key", "req-2"));
    expect(forged.status).toBe(401);

    const detail = await engine.getRunDetail("acme", runId);
    expect(detail?.run.trigger).toMatchObject({
      body: { contactId: "c_42" },
      headers: { "x-request-id": "req-1" },
    });
  });
});
