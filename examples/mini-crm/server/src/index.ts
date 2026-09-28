/**
 * Starts the mini CRM server on port 8787 (or `PORT`) with a background worker. Storage is in
 * memory unless `DATABASE_URL` points at Postgres.
 *
 * @module
 */
import type { StorageAdapter } from "@flowkit/engine";
import { createMemoryStorage } from "@flowkit/storage-memory";
import { createPostgresStorage, migrate } from "@flowkit/storage-postgres";
import { serve } from "@hono/node-server";
import pg from "pg";
import { createMiniCrm, TENANT_ID } from "./app";

const port = Number(process.env.PORT ?? 8787);
const publicUrl = process.env.PUBLIC_URL ?? `http://localhost:${port}`;

async function createStorage(): Promise<{ storage: StorageAdapter; label: string }> {
  const url = process.env.DATABASE_URL;
  if (!url) return { storage: createMemoryStorage(), label: "memory" };
  const pool = new pg.Pool({ connectionString: url });
  await migrate(pool);
  return { storage: createPostgresStorage({ pool }), label: "postgres" };
}

const { storage, label } = await createStorage();
const { app, engine } = await createMiniCrm({ storage, publicUrl });
const worker = engine.startWorker({ concurrency: 2, pollMs: 250 });

const server = serve({ fetch: app.fetch, port }, () => {
  console.info(`mini-crm server on ${publicUrl} (storage: ${label}, tenant: ${TENANT_ID})`);
  console.info(`  CRM API:     ${publicUrl}/api/contacts`);
  console.info(`  Flowkit API: ${publicUrl}/flowkit/manifest`);
  console.info(`  Webhooks:    ${publicUrl}/api/demo`);
});

async function shutdown(): Promise<void> {
  await worker.stop();
  server.close();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
