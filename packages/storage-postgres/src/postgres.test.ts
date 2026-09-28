import { PGlite } from "@electric-sql/pglite";
import type { WorkflowDoc } from "@flowkit/core";
import { FlowkitStorageError } from "@flowkit/engine";
import { runStorageConformance } from "@flowkit/engine/conformance";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createPostgresStorage, migrate, type PgStorageOptions } from "./index";
import { withTransaction } from "./migrate";
import { pgliteQueryable } from "./testing";

// One PGlite instance per test file; every conformance case gets its own schema, so each starts
// from an empty database without paying PGlite's start-up cost per case.
const lite = new PGlite();
const litePool = pgliteQueryable(lite);
let schemaCounter = 0;

/** A fresh, migrated schema on `pool` plus a cleanup that drops it. */
async function freshStorage(pool: PgStorageOptions["pool"], prefix: string) {
  const schema = `${prefix}_${++schemaCounter}`;
  await migrate(pool, schema);
  return {
    storage: createPostgresStorage({ pool, schema }),
    cleanup: async () => {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    },
  };
}

afterAll(async () => {
  await lite.close();
});

runStorageConformance("postgres (pglite)", () => freshStorage(litePool, "conf"));

const pgUrl = process.env.FLOWKIT_PG_URL;
if (pgUrl) {
  const pool = new pg.Pool({ connectionString: pgUrl, max: 10 });
  afterAll(async () => {
    await pool.end();
  });
  runStorageConformance("postgres (server)", () =>
    freshStorage(pool, `flowkit_test_${process.pid}`),
  );

  it("server: parallel workers claim each run exactly once (SKIP LOCKED)", async () => {
    const { storage: s, cleanup } = await freshStorage(pool, `flowkit_stress_${process.pid}`);
    try {
      const ids = Array.from({ length: 40 }, (_, i) => `r${i}`);
      for (const id of ids) {
        await s.createRun(
          {
            id,
            tenantId: "t",
            workflowId: "wf",
            version: 1,
            status: "queued",
            trigger: null,
            journal: {},
            attempt: 1,
            startedBy: { kind: "manual" },
          },
          [{ runId: id, tenantId: "t", type: "run.started", at: 0 }],
          0,
        );
      }
      const claimed: string[] = [];
      const worker = async (w: number) => {
        for (;;) {
          const lease = await s.claimRun({ workerId: `w${w}`, leaseMs: 60_000, now: 1 });
          if (!lease) return;
          claimed.push(lease.run.id);
          const ok = await s.commit(
            lease,
            { status: "completed" },
            [
              { runId: lease.run.id, tenantId: "t", type: "run.completed", at: 2 },
              { runId: "shared", tenantId: "t", type: "step.started", at: 2 },
            ],
            2,
          );
          expect(ok).toBe(true);
        }
      };
      await Promise.all(Array.from({ length: 8 }, (_, w) => worker(w)));
      expect([...claimed].sort()).toEqual([...ids].sort());
      const shared = (await s.listEvents("t", "shared")).map((e) => e.seq);
      expect(shared).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    } finally {
      await cleanup();
    }
  });
}

describe("migrate", () => {
  it("is idempotent", async () => {
    await migrate(litePool, "idem");
    await migrate(litePool, "idem");
    const s = createPostgresStorage({ pool: litePool, schema: "idem" });
    await s.createRun(
      {
        id: "r1",
        tenantId: "t",
        workflowId: "wf",
        version: 1,
        status: "queued",
        trigger: null,
        journal: {},
        attempt: 1,
        startedBy: { kind: "manual" },
      },
      [],
      1,
    );
    await migrate(litePool, "idem");
    expect((await s.getRun("t", "r1"))?.id).toBe("r1");
    const { rows } = await litePool.query<{ version: number; applied_at: unknown }>(
      "SELECT version, applied_at FROM idem.schema_migrations ORDER BY version",
    );
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3]);
    expect(rows[0]?.applied_at).not.toBeNull();
  });

  it("works on a bare Queryable under a session advisory lock it releases", async () => {
    const bare = { query: litePool.query.bind(litePool) };
    await migrate(bare, "bare");
    await migrate(bare, "bare");
    const versions = await litePool.query<{ version: number }>(
      "SELECT version FROM bare.schema_migrations",
    );
    expect(versions.rows.map((r) => r.version)).toEqual([1, 2, 3]);
    const locks = await litePool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'",
    );
    expect(locks.rows[0]?.n).toBe(0);
  });

  it("uses the flowkit schema by default", async () => {
    await migrate(litePool);
    const s = createPostgresStorage({ pool: litePool });
    expect(await s.recordDedupeKey("t", "k", 0, 10)).toBe(true);
    const { rows } = await litePool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM flowkit.dedupe_keys",
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("rejects unsafe schema names", async () => {
    await expect(migrate(litePool, 'x"; DROP TABLE y; --')).rejects.toThrow(/schema/i);
    expect(() => createPostgresStorage({ pool: litePool, schema: "a b" })).toThrow(/schema/i);
  });

  it("upgrades a v1 schema to the latest, keeping existing runs", async () => {
    // Recreate the v1 state: only migration 1 applied.
    await migrate(litePool, "upgrade");
    await litePool.query("ALTER TABLE upgrade.runs DROP COLUMN cancel_requested_at");
    await litePool.query("ALTER TABLE upgrade.runs DROP COLUMN cancel_request");
    await litePool.query("DELETE FROM upgrade.schema_migrations WHERE version >= 2");
    await litePool.query(
      `INSERT INTO upgrade.runs (id, tenant_id, workflow_id, version, status, attempt, started_by,
         created_at, updated_at) VALUES ('old', 't', 'wf', 1, 'queued', 1, '{"kind":"manual"}', 1, 1)`,
    );
    await migrate(litePool, "upgrade");
    const s = createPostgresStorage({ pool: litePool, schema: "upgrade" });
    expect(await s.requestCancel("t", "old", 5, { by: "ops" })).toBe(true);
    const old = await s.getRun("t", "old");
    expect(old?.cancelRequestedAt).toBe(5);
    expect(old?.cancelRequest).toEqual({ by: "ops" });
  });
});

describe("createPostgresStorage", () => {
  it("requires pool.connect() for transactional methods", async () => {
    await migrate(litePool, "noconnect");
    const s = createPostgresStorage({
      pool: { query: (sql, params) => litePool.query(sql, params) },
      schema: "noconnect",
    });
    // Single-statement methods work on a bare Queryable.
    expect(await s.recordDedupeKey("t", "k", 0, 10)).toBe(true);
    await expect(
      s.appendEvents([{ runId: "r", tenantId: "t", type: "run.started", at: 1 }]),
    ).rejects.toThrow(/connect/);
  });

  it("keeps an explicit null output and event data distinct from absent ones", async () => {
    const { storage: s, cleanup } = await freshStorage(litePool, "nulls");
    try {
      await s.createRun(
        {
          id: "r1",
          tenantId: "t",
          workflowId: "wf",
          version: 1,
          status: "queued",
          trigger: null,
          journal: {},
          attempt: 1,
          startedBy: { kind: "manual" },
        },
        [
          { runId: "r1", tenantId: "t", type: "run.started", at: 1 },
          { runId: "r1", tenantId: "t", type: "step.completed", at: 2, data: null },
        ],
        1,
      );
      expect("output" in ((await s.getRun("t", "r1")) ?? {})).toBe(false);
      const lease = await s.claimRun({ workerId: "w", leaseMs: 10, now: 2 });
      expect(await s.commit(lease!, { output: null }, [], 3)).toBe(true);
      const run = await s.getRun("t", "r1");
      expect(run && "output" in run).toBe(true);
      expect(run?.output).toBeNull();
      const events = await s.listEvents("t", "r1");
      expect("data" in events[0]!).toBe(false);
      expect("data" in events[1]!).toBe(true);
      expect(events[1]?.data).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("round-trips workflow doc object keys in their saved order", async () => {
    const { storage: s, cleanup } = await freshStorage(litePool, "keyorder");
    try {
      const doc: WorkflowDoc = {
        name: "Key order",
        id: "ko",
        trigger: { type: "manual", config: { zeta: 1, alpha: 2 } },
        steps: [
          {
            type: "branch",
            id: "pick",
            config: { longerKey: 1, b: 2, a: 3 },
            branches: { z: [], a: [], middle: [] },
          },
        ],
      };
      await s.saveWorkflowVersion("t", doc, "u", 1);
      await s.publishVersion("t", "ko", 1, 2);
      for (const read of [
        await s.getWorkflowVersion("t", "ko", 1),
        await s.getLatestVersion("t", "ko"),
        await s.getPublishedVersion("t", "ko"),
        (await s.listPublished({ tenantId: "t" }))[0],
      ]) {
        const got = read!.doc;
        expect(got).toEqual(doc);
        expect(Object.keys(got)).toEqual(["name", "id", "trigger", "steps"]);
        expect(Object.keys(got.trigger.config)).toEqual(["zeta", "alpha"]);
        const step = got.steps[0]!;
        expect(Object.keys(step)).toEqual(["type", "id", "config", "branches"]);
        expect(Object.keys(step.config)).toEqual(["longerKey", "b", "a"]);
        expect(Object.keys(step.branches!)).toEqual(["z", "a", "middle"]);
      }
    } finally {
      await cleanup();
    }
  });

  it("rejects strings containing NUL with a FlowkitStorageError and writes nothing", async () => {
    const { storage: s, cleanup } = await freshStorage(litePool, "nul");
    try {
      const run = {
        id: "r1",
        tenantId: "t",
        workflowId: "wf",
        version: 1,
        status: "queued" as const,
        trigger: { note: "a\u0000b" },
        journal: {},
        attempt: 1,
        startedBy: { kind: "manual" as const },
      };
      // NUL inside a jsonb value (SQLSTATE 22P05).
      await expect(s.createRun(run, [], 1)).rejects.toThrow(FlowkitStorageError);
      await expect(s.createRun(run, [], 1)).rejects.toThrow(/NUL/);
      expect(await s.getRun("t", "r1")).toBeNull();
      // NUL inside a text column (SQLSTATE 22021).
      await expect(s.recordDedupeKey("t", "k\u0000", 0, 10)).rejects.toThrow(FlowkitStorageError);
      // Other database errors pass through unchanged.
      const other = createPostgresStorage({ pool: litePool, schema: "does_not_exist" });
      const err = await other.getRun("t", "r1").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(FlowkitStorageError);
    } finally {
      await cleanup();
    }
  });
});

describe("withTransaction", () => {
  it("destroys the client when ROLLBACK fails", async () => {
    const rollbackError = new Error("connection lost");
    const released: unknown[][] = [];
    const client = {
      async query(sql: string) {
        if (sql === "ROLLBACK") throw rollbackError;
        return { rows: [] };
      },
      release: (...args: unknown[]) => {
        released.push(args);
      },
    };
    const pool = { query: client.query, connect: async () => client };
    const failure = new Error("statement failed");
    await expect(
      withTransaction(pool, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(released).toEqual([[rollbackError]]);

    // A successful ROLLBACK returns the client to the pool normally.
    const healthy = { ...client, query: async () => ({ rows: [] }) };
    released.length = 0;
    await expect(
      withTransaction({ ...pool, connect: async () => healthy }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(released).toEqual([[]]);
  });
});
