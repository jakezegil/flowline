/**
 * Starts the mini CRM server on port 8787 (or `PORT`) with a background worker. Storage is in
 * memory unless `DATABASE_URL` points at Postgres. `MINI_CRM_FAKE_CLOCK=1` runs the CRM and the
 * engine on a clock that `POST /api/demo/advance { ms }` moves forward (off by default).
 *
 * @module
 */
import type { StorageAdapter } from "@flowlinejs/engine";
import { createMemoryStorage } from "@flowlinejs/storage-memory";
import { createPostgresStorage, migrate } from "@flowlinejs/storage-postgres";
import { serve } from "@hono/node-server";
import pg from "pg";
import { createMiniCrm, TENANT_ID } from "./app";
import { createFakeClock } from "./fake-clock";

const port = Number(process.env.PORT ?? 8787);
const publicUrl = process.env.PUBLIC_URL ?? `http://localhost:${port}`;
const fakeClock = process.env.MINI_CRM_FAKE_CLOCK === "1" ? createFakeClock() : undefined;

interface Storage {
  storage: StorageAdapter;
  label: string;
  close(): Promise<void>;
}

async function createStorage(): Promise<Storage> {
  const url = process.env.DATABASE_URL;
  if (!url) return { storage: createMemoryStorage(), label: "memory", close: async () => {} };
  const pool = new pg.Pool({ connectionString: url });
  try {
    await migrate(pool);
  } catch (err) {
    await pool.end();
    throw err;
  }
  return { storage: createPostgresStorage({ pool }), label: "postgres", close: () => pool.end() };
}

async function main(): Promise<void> {
  const { storage, label, close } = await createStorage();
  const { app, engine } = await createMiniCrm({
    storage,
    publicUrl,
    ...(fakeClock
      ? { clock: fakeClock.now, advanceClock: fakeClock.advance, rewindClock: fakeClock.reset }
      : {}),
  });
  // With the fake clock, sweep poll triggers every second: after an advance, the next sweep
  // (the route runs one too) sees the new time without waiting the default 15 s.
  const worker = engine.startWorker({
    concurrency: 2,
    pollMs: 250,
    ...(fakeClock ? { pollEveryMs: 1000 } : {}),
  });

  const server = serve({ fetch: app.fetch, port }, () => {
    console.info(`mini-crm server on ${publicUrl} (storage: ${label}, tenant: ${TENANT_ID})`);
    if (fakeClock) console.info("  Fake clock:  POST /api/demo/advance { ms } moves time forward");
    console.info(`  CRM API:     ${publicUrl}/api/contacts`);
    console.info(`  Flowline API: ${publicUrl}/flowline/manifest`);
    console.info(`  Webhooks:    ${publicUrl}/api/demo`);
  });

  const shutdown = async (): Promise<void> => {
    server.close();
    await worker.stop();
    await close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  // A refused connection is an AggregateError with an empty message but a code.
  const code = (err as { code?: unknown } | null)?.code;
  const reason = err instanceof Error && err.message ? err.message : String(code ?? err);
  console.error(`mini-crm failed to start: ${reason}`);
  process.exit(1);
});
