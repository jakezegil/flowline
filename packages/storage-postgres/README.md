# @flowkit/storage-postgres

Postgres `StorageAdapter` for the Flowkit engine.

```ts
import pg from "pg";
import { createPostgresStorage, migrate } from "@flowkit/storage-postgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await migrate(pool); // idempotent; creates schema "flowkit"
const storage = createPostgresStorage({ pool });
```

- `pool` is any `Queryable` (`query(sql, params) → { rows }`). Methods that write more than one
  statement run in a transaction on a connection from `pool.connect()`, so pass a pool (or
  anything with `connect()`/`release()`), not a single shared client.
- `schema` (default `"flowkit"`) selects the Postgres schema; `migrate(db, schema)` must use the
  same one.
- `claimRun` is a single `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)` statement, so any
  number of workers in any number of processes can poll the same database.
- Event `seq` numbers are assigned under a per-run transaction-scoped advisory lock.

## Testing

`@flowkit/storage-postgres/testing` exports `pgliteQueryable(db)`, which wraps an
[`@electric-sql/pglite`](https://pglite.dev) instance as a pool. The package's tests run the
engine's storage conformance suite against PGlite, and additionally against a real server when
`FLOWKIT_PG_URL` is set:

```sh
FLOWKIT_PG_URL=postgres://user@localhost:5432/db pnpm vitest run --project storage-postgres
```

PGlite is a single connection, so `pgliteQueryable` serialises every statement and transaction.
On PGlite the conformance suite's concurrency cases therefore exercise correctness only, not
parallelism; run against a real server (`FLOWKIT_PG_URL`) to exercise `SKIP LOCKED` and lock
contention for real.
