/**
 * Test helpers for running the Postgres adapter on PGlite (in-process WASM Postgres), exposed as
 * `@flowlinejs/storage-postgres/testing`.
 *
 * @module
 */
import type { Queryable } from "./migrate";

/** The part of a PGlite instance (`@electric-sql/pglite`) that {@link pgliteQueryable} uses. */
export interface PGliteLike {
  /** Run one parameterised statement. */
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Wrap a PGlite instance as a pool for `createPostgresStorage` and `migrate`.
 *
 * PGlite is a single connection, so a transaction (`BEGIN` ... `COMMIT`) must not interleave with
 * any other statement. `connect()` therefore hands out the connection exclusively: until the
 * returned client is released, every other `query()` and `connect()` waits in FIFO order. This
 * serialises all access, so concurrency tests on PGlite check correctness, not parallelism.
 */
export function pgliteQueryable(
  db: PGliteLike,
): Queryable & { connect(): Promise<Queryable & { release(err?: Error | boolean): void }> } {
  let tail: Promise<void> = Promise.resolve();
  /** Wait for exclusive access; resolves to the function that gives it up. */
  const acquire = (): Promise<() => void> => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = tail;
    tail = previous.then(() => released);
    return previous.then(() => release);
  };

  return {
    async query<T>(sql: string, params?: unknown[]) {
      const release = await acquire();
      try {
        return await db.query<T>(sql, params);
      } finally {
        release();
      }
    },
    async connect() {
      const release = await acquire();
      let done = false;
      return {
        query: <T>(sql: string, params?: unknown[]) => db.query<T>(sql, params),
        // The argument (pg's "destroy this connection") is ignored: PGlite has one connection.
        release(_err?: Error | boolean) {
          if (done) return;
          done = true;
          release();
        },
      };
    },
  };
}
