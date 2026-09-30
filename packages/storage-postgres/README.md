# @flowlinejs/storage-postgres

Postgres `StorageAdapter` for the Flowline engine.

```ts file=storage.ts
import pg from "pg";
import { createPostgresStorage, migrate } from "@flowlinejs/storage-postgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await migrate(pool); // idempotent; creates schema "flowline"
const storage = createPostgresStorage({ pool });
```

- `pool` is any `Queryable` (`query(sql, params) → { rows }`). Methods that write more than one
  statement run in a transaction on a connection from `pool.connect()`, so pass a pool (or
  anything with `connect()`/`release()`), not a single shared client.
- `schema` (default `"flowline"`) selects the Postgres schema; `migrate(db, schema)` must use the
  same one.
- `claimRun` is a single `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)` statement, so any
  number of workers in any number of processes can poll the same database.
- Event `seq` numbers are assigned under a per-run transaction-scoped advisory lock.
- `migrate` is versioned: applied versions are recorded in `<schema>.schema_migrations`, and only
  the missing ones run, in order, under an advisory lock. With `connect()` (e.g. `pg.Pool`) it
  runs in one transaction. Without `connect()`, `db` must be a single connection (e.g.
  `pg.Client`), because the session-level lock and the statements have to share that connection.

## Limitations

- **No NUL characters.** Postgres cannot store strings containing `\u0000` in `text` or `jsonb`
  columns (SQLSTATE `22021` / `22P05`). Such a write fails with a `FlowlineStorageError`
  explaining this, and nothing is written. That applies anywhere in run IDs, trigger payloads,
  journal outputs, event data, dedupe keys, and so on. (The memory adapter accepts NUL.)
- **Claim ordering is unindexed.** `claimRun` orders the eligible runs by
  `coalesce(wake_at, updated_at), created_at, id`. The indexes narrow runs down by status, but the
  sort itself is not index-backed, so each claim costs time proportional to the number of
  currently eligible runs (queued, due, or with an expired lease). That is fine for typical queue
  depths; with very deep backlogs, expect claims to slow down linearly.
- Workflow documents are stored as `json`, so their object key order is kept exactly. Runs,
  journals and events use `jsonb`, which does not keep key order.

## Testing

`@flowlinejs/storage-postgres/testing` exports `pgliteQueryable(db)`, which wraps an
[`@electric-sql/pglite`](https://pglite.dev) instance as a pool. The package's tests run the
engine's storage conformance suite against PGlite, and additionally against a real server when
`FLOWLINE_PG_URL` is set:

```sh
FLOWLINE_PG_URL=postgres://user@localhost:5432/db pnpm vitest run --project storage-postgres
```

PGlite is a single connection, so `pgliteQueryable` serialises every statement and transaction.
On PGlite the conformance suite's concurrency cases therefore exercise correctness only, not
parallelism; run against a real server (`FLOWLINE_PG_URL`) to exercise `SKIP LOCKED` and lock
contention for real.
