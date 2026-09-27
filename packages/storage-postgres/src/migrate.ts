/**
 * The minimal database interface the adapter runs on, transactions, and schema migration.
 *
 * @module
 */
import { bootstrapStatements, migrations, quoteSchema } from "./schema";

/**
 * Anything that runs one parameterised SQL statement (`$1`, `$2`, ... placeholders), such as a
 * `pg.Pool`, a `pg.Client`, or a PGlite instance wrapped with `pgliteQueryable`.
 */
export interface Queryable {
  // biome-ignore lint/suspicious/noExplicitAny: rows are untyped unless the caller says otherwise.
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * A dedicated connection handed out by {@link PoolLike.connect}. `release(err)` with an error (or
 * `true`) tells the pool the connection is broken and must be destroyed, not reused (`pg`
 * semantics).
 */
export type PoolClientLike = Queryable & { release(err?: Error | boolean): void };

/**
 * A {@link Queryable} that can also hand out a dedicated connection (like `pg.Pool`), which the
 * adapter needs for multi-statement transactions.
 */
export type PoolLike = Queryable & { connect?(): Promise<PoolClientLike> };

/**
 * Run `fn` inside `BEGIN` ... `COMMIT` on a dedicated connection from `pool.connect()`; any error
 * rolls the transaction back and is rethrown. If the `ROLLBACK` itself fails, the connection is
 * released with that error so the pool destroys it instead of reusing a broken connection.
 *
 * @throws {Error} if `pool` has no `connect()`.
 */
export async function withTransaction<T>(
  pool: PoolLike,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  if (!pool.connect) {
    throw new Error(
      "@flowkit/storage-postgres: this operation needs a transaction, so the pool must provide connect()",
    );
  }
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
    }
    throw err;
  } finally {
    if (broken) client.release(broken);
    else client.release();
  }
}

/** Create the bookkeeping table, then apply every migration not yet recorded, in order. */
async function applyMigrations(q: Queryable, s: string): Promise<void> {
  for (const sql of bootstrapStatements(s)) await q.query(sql);
  const { rows } = await q.query<{ version: unknown }>(
    `SELECT version FROM ${s}.schema_migrations`,
  );
  const applied = new Set(rows.map((r) => Number(r.version)));
  for (const m of migrations(s)) {
    if (applied.has(m.version)) continue;
    for (const sql of m.statements) await q.query(sql);
    await q.query(`INSERT INTO ${s}.schema_migrations (version) VALUES ($1)`, [m.version]);
  }
}

/**
 * Bring `schema` (default `"flowkit"`) up to date: create it and its `schema_migrations` table,
 * then apply, in version order, every migration not yet recorded there. Idempotent, so it is safe
 * to call on every start-up.
 *
 * Concurrent callers are serialised by an advisory lock keyed on the schema name:
 * - when `db` provides `connect()` (e.g. `pg.Pool`), everything runs in ONE transaction under
 *   `pg_advisory_xact_lock`, so a failed migration leaves nothing behind;
 * - otherwise `db` must be a single connection (e.g. `pg.Client`): the statements run under a
 *   session-level `pg_advisory_lock`, released afterwards, and are not transactional.
 *
 * @throws {Error} if `schema` is not a plain identifier.
 */
export async function migrate(db: Queryable, schema = "flowkit"): Promise<void> {
  const s = quoteSchema(schema);
  const lockKey = `flowkit.migrate:${schema}`;
  const pool = db as PoolLike;
  if (pool.connect) {
    await withTransaction(pool, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
      await applyMigrations(tx, s);
    });
    return;
  }
  await db.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
  try {
    await applyMigrations(db, s);
  } finally {
    await db.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
  }
}
