/**
 * The minimal database interface the adapter runs on, transactions, and schema migration.
 *
 * @module
 */
import { quoteSchema, schemaStatements } from "./schema";

/**
 * Anything that runs one parameterised SQL statement (`$1`, `$2`, ... placeholders), such as a
 * `pg.Pool`, a `pg.Client`, or a PGlite instance wrapped with `pgliteQueryable`.
 */
export interface Queryable {
  // biome-ignore lint/suspicious/noExplicitAny: rows are untyped unless the caller says otherwise.
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * A {@link Queryable} that can also hand out a dedicated connection (like `pg.Pool`), which the
 * adapter needs for multi-statement transactions.
 */
export type PoolLike = Queryable & { connect?(): Promise<Queryable & { release(): void }> };

/**
 * Run `fn` inside `BEGIN` ... `COMMIT` on a dedicated connection from `pool.connect()`; any error
 * rolls the transaction back and is rethrown.
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
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Create the adapter's tables and indexes in `schema` (default `"flowkit"`). Idempotent: every
 * statement is `CREATE ... IF NOT EXISTS`, so it is safe to call on every start-up. When `db`
 * provides `connect()`, the statements run in one transaction under an advisory lock, so concurrent
 * callers do not race each other.
 *
 * @throws {Error} if `schema` is not a plain identifier.
 */
export async function migrate(db: Queryable, schema = "flowkit"): Promise<void> {
  const s = quoteSchema(schema);
  const statements = schemaStatements(s);
  const pool = db as PoolLike;
  if (!pool.connect) {
    for (const sql of statements) await db.query(sql);
    return;
  }
  await withTransaction(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `flowkit.migrate:${schema}`,
    ]);
    for (const sql of statements) await tx.query(sql);
  });
}
