import { PGlite } from "@electric-sql/pglite";
import { runStorageConformance } from "@flowkit/engine/testing";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createPostgresStorage, migrate, type PgStorageOptions } from "./index";
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
});
