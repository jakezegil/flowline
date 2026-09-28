/**
 * Postgres {@link StorageAdapter} for Flowkit. Runs on any {@link Queryable} (a `pg.Pool` in
 * production, PGlite in tests); leasing uses `FOR UPDATE SKIP LOCKED`, and every multi-statement
 * write runs in one transaction on a connection from `pool.connect()`.
 *
 * @module
 */
import type {
  JournalEntry,
  RunEvent,
  RunSummary,
  WorkflowSummary,
  WorkflowVersion,
} from "@flowkit/core";
import {
  FlowkitStorageError,
  type NewRun,
  type NewRunEvent,
  type ResumeEvent,
  type Run,
  type RunPatch,
  type StorageAdapter,
  type WorkflowAuditEntry,
} from "@flowkit/engine";
import { type PoolLike, type Queryable, withTransaction } from "./migrate";
import { quoteSchema } from "./schema";

export { migrate, type PoolClientLike, type PoolLike, type Queryable } from "./migrate";

/** Package version. */
export const VERSION = "0.1.0";

/** Options of {@link createPostgresStorage}. */
export interface PgStorageOptions {
  /**
   * Where queries run, typically a `pg.Pool`. `connect()` is required for the transactional
   * methods (everything that writes more than one statement); single-statement methods work
   * without it.
   */
  pool: Queryable & { connect?(): Promise<Queryable & { release(err?: Error | boolean): void }> };
  /** Postgres schema holding the tables (created by {@link migrate}). Default `"flowkit"`. */
  schema?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: database rows are untyped.
type Row = Record<string, any>;

/** Collects positional parameters while building a statement. */
class Params {
  readonly values: unknown[] = [];
  /** Add `value` and return its placeholder (`$n`). */
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** Serialise a value for a `jsonb` parameter; `undefined` becomes SQL NULL. */
const json = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value);

/** `bigint` columns arrive as strings from `pg`; normalise every numeric column to `number`. */
const num = (value: unknown): number | undefined =>
  value === null || value === undefined ? undefined : Number(value);

const RUN_INSERT_COLUMNS = [
  "id",
  "tenant_id",
  "workflow_id",
  "version",
  "status",
  "trigger",
  "journal",
  "attempt",
  "current_step",
  "wake_at",
  "wait_reason",
  "callback_token",
  "callback_expires_at",
  "resume",
  "parent",
  "output",
  "error",
  "started_by",
  "cancel_requested_at",
  "cancel_request",
  "created_at",
  "updated_at",
].join(", ");

/** Columns every run read selects from alias `r`; `has_output` tells JSON `null` from absent. */
const RUN_COLUMNS = "r.*, (r.output IS NOT NULL) AS has_output";
const EVENT_COLUMNS = "e.*, (e.data IS NOT NULL) AS has_data";
const CLEAR_LEASE = "lease_owner = NULL, lease_until = NULL, lease_token = NULL";

function toRun(row: Row): Run {
  const run: Run = {
    id: row.id,
    tenantId: row.tenant_id,
    workflowId: row.workflow_id,
    version: Number(row.version),
    status: row.status,
    trigger: row.trigger,
    journal: row.journal ?? {},
    attempt: Number(row.attempt),
    startedBy: row.started_by,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
  if (row.current_step !== null) run.currentStep = row.current_step;
  if (row.wake_at !== null) run.wakeAt = num(row.wake_at);
  if (row.wait_reason !== null) run.waitReason = row.wait_reason;
  if (row.callback_token !== null) run.callbackToken = row.callback_token;
  if (row.callback_expires_at !== null) run.callbackExpiresAt = num(row.callback_expires_at);
  if (row.resume !== null) run.resume = row.resume;
  if (row.parent !== null) run.parent = row.parent;
  if (row.has_output) run.output = row.output;
  if (row.error !== null) run.error = row.error;
  if (row.cancel_requested_at !== null) run.cancelRequestedAt = num(row.cancel_requested_at);
  if (row.cancel_request !== null && row.cancel_request !== undefined) {
    run.cancelRequest = row.cancel_request;
  }
  if (row.lease_owner !== null) run.leaseOwner = row.lease_owner;
  if (row.lease_until !== null) run.leaseUntil = num(row.lease_until);
  return run;
}

function toSummary(row: Row): RunSummary {
  const summary: RunSummary = {
    id: row.id,
    workflowId: row.workflow_id,
    version: Number(row.version),
    status: row.status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    startedBy: row.started_by,
  };
  if (row.error !== null) summary.error = row.error;
  if (typeof row.stopped_at === "string") summary.stoppedAt = row.stopped_at;
  return summary;
}

function toEvent(row: Row): RunEvent {
  const event: RunEvent = {
    id: row.id,
    runId: row.run_id,
    tenantId: row.tenant_id,
    seq: Number(row.seq),
    type: row.type,
    at: Number(row.at),
  };
  if (row.step_path !== null) event.stepPath = row.step_path;
  if (row.worker_id !== null) event.workerId = row.worker_id;
  if (row.has_data) event.data = row.data;
  return event;
}

function toVersion(row: Row): WorkflowVersion {
  return {
    workflowId: row.workflow_id,
    tenantId: row.tenant_id,
    version: Number(row.version),
    doc: row.doc,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
  };
}

/**
 * SQLSTATEs Postgres raises for strings it cannot store: `22P05` (untranslatable character, e.g.
 * `\u0000` inside `jsonb`) and `22021` (invalid byte sequence, e.g. a NUL byte in `text`).
 */
const UNSTORABLE_STRING_CODES = new Set(["22P05", "22021"]);

/** Turn Postgres's "unstorable string" errors into a {@link FlowkitStorageError}. */
function translateError(err: unknown): unknown {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string" || !UNSTORABLE_STRING_CODES.has(code)) return err;
  const detail = err instanceof Error ? err.message : String(err);
  return new FlowkitStorageError(
    `Postgres cannot store this value: strings containing NUL (\\u0000) or invalid UTF-8 are not supported (SQLSTATE ${code}: ${detail})`,
    { cause: err },
  );
}

/** Wrap `pool` (and the clients it hands out) so every query error goes through translateError. */
function withErrorTranslation(pool: PoolLike): PoolLike {
  const wrap =
    (q: Queryable): Queryable["query"] =>
    async (sql, params) => {
      try {
        return await q.query(sql, params);
      } catch (err) {
        throw translateError(err);
      }
    };
  const connect = pool.connect?.bind(pool);
  return {
    query: wrap(pool),
    connect: connect
      ? async () => {
          const client = await connect();
          return { query: wrap(client), release: (err) => client.release(err) };
        }
      : undefined,
  };
}

/**
 * `SET` assignments for the run's own fields of `patch` (not `createChild`/`wakeParent`), plus
 * `updated_at`. Lease clearing is left to the caller.
 */
function patchAssignments(patch: RunPatch, now: number, p: Params): string[] {
  const sets: string[] = [];
  /** `undefined` keeps the column, `null` clears it, anything else sets it. */
  const opt = (column: string, value: unknown) => {
    if (value === undefined) return;
    sets.push(`${column} = ${value === null ? "NULL" : p.add(value)}`);
  };
  const optJson = (column: string, value: unknown) => {
    if (value === undefined) return;
    sets.push(`${column} = ${value === null ? "NULL" : `${p.add(json(value))}::jsonb`}`);
  };

  if (patch.status !== undefined) sets.push(`status = ${p.add(patch.status)}`);
  if (patch.journal) {
    const deleted: string[] = [];
    const merged: Record<string, JournalEntry> = {};
    for (const [key, entry] of Object.entries(patch.journal)) {
      if (entry === null) deleted.push(key);
      // Own-property write: keys like `__proto__` must stay plain data keys.
      else Object.defineProperty(merged, key, { value: entry, enumerable: true });
    }
    sets.push(
      `journal = (journal - ${p.add(deleted)}::text[]) || ${p.add(JSON.stringify(merged))}::jsonb`,
    );
  }
  if (patch.attempt !== undefined) sets.push(`attempt = ${p.add(patch.attempt)}`);
  opt("current_step", patch.currentStep);
  opt("wake_at", patch.wakeAt);
  opt("wait_reason", patch.waitReason);
  opt("callback_token", patch.callbackToken);
  opt("callback_expires_at", patch.callbackExpiresAt);
  optJson("resume", patch.resume);
  if (patch.output !== undefined) sets.push(`output = ${p.add(json(patch.output))}::jsonb`);
  optJson("error", patch.error);
  opt("cancel_requested_at", patch.cancelRequestedAt);
  // Clearing the request clears who asked for it too.
  if (patch.cancelRequestedAt === null) sets.push("cancel_request = NULL");
  sets.push(`updated_at = ${p.add(now)}`);
  return sets;
}

/**
 * Create a Postgres-backed {@link StorageAdapter}. Run {@link migrate} on the same database and
 * schema first.
 *
 * Every guarded write checks its condition in the same statement or transaction as the write, so
 * any number of processes can share one database. Event `seq` numbers are assigned under a
 * per-run transaction-scoped advisory lock, which keeps them unique and gap-free under concurrency.
 *
 * @throws {Error} if `opts.schema` is not a plain identifier.
 */
export function createPostgresStorage(opts: PgStorageOptions): StorageAdapter {
  const pool = withErrorTranslation(opts.pool);
  const schemaName = opts.schema ?? "flowkit";
  const s = quoteSchema(schemaName);
  const tx = <T>(fn: (q: Queryable) => Promise<T>) => withTransaction(pool, fn);

  /** Insert `run` unless its id exists; returns the inserted row, or `undefined` on conflict. */
  const insertRun = async (q: Queryable, run: NewRun, now: number): Promise<Row | undefined> => {
    const p = new Params();
    const values = [
      p.add(run.id),
      p.add(run.tenantId),
      p.add(run.workflowId),
      p.add(run.version),
      p.add(run.status),
      `${p.add(json(run.trigger))}::jsonb`,
      `${p.add(json(run.journal ?? {}))}::jsonb`,
      p.add(run.attempt),
      p.add(run.currentStep ?? null),
      p.add(run.wakeAt ?? null),
      p.add(run.waitReason ?? null),
      p.add(run.callbackToken ?? null),
      p.add(run.callbackExpiresAt ?? null),
      `${p.add(json(run.resume))}::jsonb`,
      `${p.add(json(run.parent))}::jsonb`,
      `${p.add(json(run.output))}::jsonb`,
      `${p.add(json(run.error))}::jsonb`,
      `${p.add(json(run.startedBy))}::jsonb`,
      p.add(run.cancelRequestedAt ?? null),
      `${p.add(json(run.cancelRequest))}::jsonb`,
      p.add(now),
      p.add(now),
    ];
    const { rows } = await q.query(
      `INSERT INTO ${s}.runs AS r (${RUN_INSERT_COLUMNS}) VALUES (${values.join(", ")})
       ON CONFLICT (id) DO NOTHING RETURNING ${RUN_COLUMNS}`,
      p.values,
    );
    return rows[0];
  };

  const tenantOf = async (q: Queryable, runId: string): Promise<string | undefined> => {
    const { rows } = await q.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM ${s}.runs WHERE id = $1`,
      [runId],
    );
    return rows[0]?.tenant_id;
  };

  /**
   * Append events inside transaction `q`. Per run (in id order, so concurrent writers cannot
   * deadlock) take an advisory lock, then number the events after the run's current max `seq`.
   */
  const appendIn = async (q: Queryable, events: NewRunEvent[]): Promise<void> => {
    if (events.length === 0) return;
    const byRun = new Map<string, NewRunEvent[]>();
    for (const e of events) byRun.set(e.runId, [...(byRun.get(e.runId) ?? []), e]);
    const runIds = [...byRun.keys()].sort();
    const p = new Params();
    const rows: string[] = [];
    for (const runId of runIds) {
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `flowkit.run_events:${schemaName}:${runId}`,
      ]);
      const { rows: maxRows } = await q.query<{ max: unknown }>(
        `SELECT coalesce(max(seq), 0) AS max FROM ${s}.run_events WHERE run_id = $1`,
        [runId],
      );
      let seq = Number(maxRows[0]?.max ?? 0);
      for (const e of byRun.get(runId) ?? []) {
        rows.push(
          `(${[
            p.add(crypto.randomUUID()),
            p.add(e.runId),
            p.add(e.tenantId),
            p.add(++seq),
            p.add(e.type),
            p.add(e.stepPath ?? null),
            p.add(e.at),
            p.add(e.workerId ?? null),
            `${p.add(json(e.data))}::jsonb`,
          ].join(", ")})`,
        );
      }
    }
    await q.query(
      `INSERT INTO ${s}.run_events (id, run_id, tenant_id, seq, type, step_path, at, worker_id, data)
       VALUES ${rows.join(", ")}`,
      p.values,
    );
  };

  /**
   * The shared tail of `commit` and `updateRunUnleased`, run inside their transaction after the
   * run's own update succeeded: insert the child (rejecting a cross-tenant id), wake the parent
   * (no-op unless its preconditions hold) and append the events — skipping the child's events
   * when the child already existed.
   */
  const applyRelated = async (
    q: Queryable,
    patch: RunPatch,
    events: NewRunEvent[],
    now: number,
  ): Promise<void> => {
    const child = patch.createChild;
    let childExisted = false;
    if (child && !(await insertRun(q, child, now))) {
      if ((await tenantOf(q, child.id)) !== child.tenantId) {
        throw new FlowkitStorageError(`Run id "${child.id}" already belongs to another tenant`);
      }
      childExisted = true;
    }
    const wake = patch.wakeParent;
    if (wake) {
      await q.query(
        `UPDATE ${s}.runs SET status = 'queued', resume = $1::jsonb, wake_at = NULL,
           callback_token = NULL, callback_expires_at = NULL, updated_at = $2
         WHERE id = $3::text AND status = 'waiting' AND current_step = $4::text
           AND journal -> $4::text ->> 'status' = 'suspended'
           AND journal -> $4::text -> 'pending' ->> 'childRunId' = $5::text`,
        [json(wake.resume), now, wake.runId, wake.stepPath, wake.childRunId],
      );
    }
    await appendIn(q, childExisted ? events.filter((e) => e.runId !== child?.id) : events);
  };

  /**
   * Resume a `waiting` run matched by `where` (the shared waiting → queued transition) and append
   * `event` to it, in one transaction.
   */
  const resumeWhere = (
    where: string,
    params: unknown[],
    resume: unknown,
    now: number,
    event: ResumeEvent | undefined,
  ): Promise<Row | undefined> =>
    tx(async (q) => {
      const n = params.length;
      const { rows } = await q.query(
        `UPDATE ${s}.runs AS r SET status = 'queued', resume = $${n + 1}::jsonb, wake_at = NULL,
           callback_token = NULL, callback_expires_at = NULL, updated_at = $${n + 2}
         WHERE r.status = 'waiting' AND ${where}
         RETURNING ${RUN_COLUMNS}`,
        [...params, json(resume), now],
      );
      const row = rows[0];
      if (row && event) {
        const e: NewRunEvent = {
          runId: row.id,
          tenantId: row.tenant_id,
          type: event.type,
          at: now,
        };
        if (row.current_step !== null) e.stepPath = row.current_step;
        if (event.data !== undefined) e.data = event.data;
        await appendIn(q, [e]);
      }
      return row;
    });

  return {
    async saveWorkflowVersion(tenantId, doc, actor, now) {
      return tx(async (q) => {
        // The upsert row-locks the workflow, so concurrent saves get consecutive versions.
        const { rows } = await q.query<{ latest_version: number }>(
          `INSERT INTO ${s}.workflows AS w (tenant_id, workflow_id, name, latest_version, updated_at)
           VALUES ($1, $2, $3, 1, $4)
           ON CONFLICT (tenant_id, workflow_id) DO UPDATE SET
             latest_version = w.latest_version + 1, name = EXCLUDED.name,
             updated_at = EXCLUDED.updated_at
           RETURNING latest_version`,
          [tenantId, doc.id, doc.name, now],
        );
        const version = Number(rows[0]?.latest_version);
        const inserted = await q.query(
          `INSERT INTO ${s}.workflow_versions
             (tenant_id, workflow_id, version, doc, trigger_type, created_by, created_at)
           VALUES ($1, $2, $3, $4::json, $5, $6, $7) RETURNING *`,
          [tenantId, doc.id, version, json(doc), doc.trigger.type, actor, now],
        );
        return toVersion(inserted.rows[0] as Row);
      });
    },

    async createWorkflowVersion(tenantId, doc, actor, now) {
      return tx(async (q) => {
        // The workflows row is the lock: of concurrent creates, one inserts it.
        const { rows } = await q.query(
          `INSERT INTO ${s}.workflows (tenant_id, workflow_id, name, latest_version, updated_at)
           VALUES ($1, $2, $3, 1, $4)
           ON CONFLICT (tenant_id, workflow_id) DO NOTHING
           RETURNING latest_version`,
          [tenantId, doc.id, doc.name, now],
        );
        if (rows.length === 0) return null;
        const inserted = await q.query(
          `INSERT INTO ${s}.workflow_versions
             (tenant_id, workflow_id, version, doc, trigger_type, created_by, created_at)
           VALUES ($1, $2, 1, $3::json, $4, $5, $6) RETURNING *`,
          [tenantId, doc.id, json(doc), doc.trigger.type, actor, now],
        );
        return toVersion(inserted.rows[0] as Row);
      });
    },

    async getWorkflowVersion(tenantId, workflowId, version) {
      const { rows } = await pool.query(
        `SELECT * FROM ${s}.workflow_versions
         WHERE tenant_id = $1 AND workflow_id = $2 AND version = $3`,
        [tenantId, workflowId, version],
      );
      return rows[0] ? toVersion(rows[0]) : null;
    },

    async getLatestVersion(tenantId, workflowId) {
      const { rows } = await pool.query(
        `SELECT * FROM ${s}.workflow_versions WHERE tenant_id = $1 AND workflow_id = $2
         ORDER BY version DESC LIMIT 1`,
        [tenantId, workflowId],
      );
      return rows[0] ? toVersion(rows[0]) : null;
    },

    async getPublishedVersion(tenantId, workflowId) {
      const { rows } = await pool.query(
        `SELECT v.* FROM ${s}.workflows w JOIN ${s}.workflow_versions v
           ON v.tenant_id = w.tenant_id AND v.workflow_id = w.workflow_id
          AND v.version = w.published_version
         WHERE w.tenant_id = $1 AND w.workflow_id = $2`,
        [tenantId, workflowId],
      );
      return rows[0] ? toVersion(rows[0]) : null;
    },

    async publishVersion(tenantId, workflowId, version, now) {
      const { rows } = await pool.query(
        `UPDATE ${s}.workflows w SET published_version = $3, published_at = $4
         WHERE w.tenant_id = $1 AND w.workflow_id = $2 AND EXISTS (
           SELECT 1 FROM ${s}.workflow_versions v
           WHERE v.tenant_id = $1 AND v.workflow_id = $2 AND v.version = $3)
         RETURNING 1`,
        [tenantId, workflowId, version, now],
      );
      if (rows.length === 0) throw new Error(`Workflow ${workflowId} has no version ${version}`);
    },

    async listWorkflows(tenantId) {
      const { rows } = await pool.query(
        `SELECT w.*, v.trigger_type FROM ${s}.workflows w JOIN ${s}.workflow_versions v
           ON v.tenant_id = w.tenant_id AND v.workflow_id = w.workflow_id
          AND v.version = w.latest_version
         WHERE w.tenant_id = $1 ORDER BY w.workflow_id COLLATE "C"`,
        [tenantId],
      );
      return rows.map(
        (row): WorkflowSummary => ({
          id: row.workflow_id,
          name: row.name,
          triggerType: row.trigger_type,
          latestVersion: Number(row.latest_version),
          publishedVersion: num(row.published_version) ?? null,
          publishedAt: num(row.published_at) ?? null,
          updatedAt: Number(row.updated_at),
        }),
      );
    },

    async listPublished(filter) {
      const p = new Params();
      const where: string[] = [];
      if (filter.tenantId !== undefined) where.push(`w.tenant_id = ${p.add(filter.tenantId)}`);
      if (filter.triggerType !== undefined) {
        where.push(`v.trigger_type = ${p.add(filter.triggerType)}`);
      }
      const { rows } = await pool.query(
        `SELECT v.* FROM ${s}.workflows w JOIN ${s}.workflow_versions v
           ON v.tenant_id = w.tenant_id AND v.workflow_id = w.workflow_id
          AND v.version = w.published_version
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
        p.values,
      );
      return rows.map(toVersion);
    },

    async appendWorkflowAudit(e) {
      await pool.query(
        `INSERT INTO ${s}.workflow_audit (tenant_id, workflow_id, version, action, actor, at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [e.tenantId, e.workflowId, e.version, e.action, e.actor, e.at],
      );
    },

    async listWorkflowAudit(tenantId, workflowId) {
      const { rows } = await pool.query(
        `SELECT * FROM ${s}.workflow_audit WHERE tenant_id = $1 AND workflow_id = $2 ORDER BY id`,
        [tenantId, workflowId],
      );
      return rows.map(
        (row): WorkflowAuditEntry => ({
          tenantId: row.tenant_id,
          workflowId: row.workflow_id,
          version: Number(row.version),
          action: row.action,
          actor: row.actor,
          at: Number(row.at),
        }),
      );
    },

    async createRun(run, events, now) {
      return tx(async (q) => {
        const inserted = await insertRun(q, run, now);
        if (inserted) {
          await appendIn(q, events);
          return toRun(inserted);
        }
        // ON CONFLICT DO NOTHING waited for any concurrent inserter, so the winner is visible.
        const { rows } = await q.query(`SELECT ${RUN_COLUMNS} FROM ${s}.runs r WHERE r.id = $1`, [
          run.id,
        ]);
        const existing = rows[0];
        if (!existing || existing.tenant_id !== run.tenantId) {
          throw new FlowkitStorageError(`Run id "${run.id}" already belongs to another tenant`);
        }
        return toRun(existing);
      });
    },

    async getRun(tenantId, runId) {
      const { rows } = await pool.query(
        `SELECT ${RUN_COLUMNS} FROM ${s}.runs r WHERE r.id = $1 AND r.tenant_id = $2`,
        [runId, tenantId],
      );
      return rows[0] ? toRun(rows[0]) : null;
    },

    async getRunById(runId) {
      const { rows } = await pool.query(`SELECT ${RUN_COLUMNS} FROM ${s}.runs r WHERE r.id = $1`, [
        runId,
      ]);
      return rows[0] ? toRun(rows[0]) : null;
    },

    async listRuns(tenantId, f) {
      const p = new Params();
      const where = [`tenant_id = ${p.add(tenantId)}`];
      if (f.workflowId !== undefined) where.push(`workflow_id = ${p.add(f.workflowId)}`);
      if (f.status !== undefined) where.push(`status = ${p.add(f.status)}`);
      if (f.topLevel === true) where.push(`started_by->>'kind' IS DISTINCT FROM 'subflow'`);
      const outer =
        f.stopped === undefined ? "" : `WHERE stopped_at IS ${f.stopped ? "NOT NULL" : "NULL"}`;
      // stopped_at: see `stoppedAtOf` (computed here so the journal isn't read out).
      const { rows } = await pool.query(
        `SELECT * FROM (
           SELECT id, workflow_id, version, status, created_at, updated_at, error, started_by,
             CASE WHEN status = 'completed' AND jsonb_typeof(output->'stoppedAt') = 'string'
               AND journal->(output->>'stoppedAt')->>'status' = 'done'
               AND journal->(output->>'stoppedAt')->'output'->'stopped' = 'true'::jsonb
             THEN output->>'stoppedAt' END AS stopped_at
           FROM ${s}.runs WHERE ${where.join(" AND ")}
         ) r ${outer}
         ORDER BY created_at DESC, id COLLATE "C" DESC LIMIT ${p.add(f.limit ?? 50)}`,
        p.values,
      );
      return rows.map(toSummary);
    },

    async claimRun({ workerId, leaseMs, now }) {
      const token = crypto.randomUUID();
      const { rows } = await pool.query(
        `UPDATE ${s}.runs AS r SET status = 'running', lease_owner = $1, lease_until = $2,
           lease_token = $3, updated_at = $4
         FROM (
           SELECT id FROM ${s}.runs
           WHERE status = 'queued'
              OR (status = 'waiting' AND wake_at <= $4)
              OR (status = 'running' AND (lease_until IS NULL OR lease_until < $4))
           ORDER BY coalesce(wake_at, updated_at), created_at, id COLLATE "C"
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         ) c
         WHERE r.id = c.id
         RETURNING ${RUN_COLUMNS}`,
        [workerId, now + leaseMs, token, now],
      );
      return rows[0] ? { run: toRun(rows[0]), token } : null;
    },

    async renewLease(lease, leaseMs, now) {
      const { rows } = await pool.query(
        `UPDATE ${s}.runs SET lease_until = $1, updated_at = $2
         WHERE id = $3 AND lease_token = $4 RETURNING id`,
        [now + leaseMs, now, lease.run.id, lease.token],
      );
      return rows.length > 0;
    },

    async commit(lease, patch, events, now) {
      return tx(async (q) => {
        const p = new Params();
        const sets = patchAssignments(patch, now, p);
        if (patch.release || (patch.status !== undefined && patch.status !== "running")) {
          sets.push(CLEAR_LEASE);
        }
        const { rows } = await q.query(
          `UPDATE ${s}.runs SET ${sets.join(", ")}
           WHERE id = ${p.add(lease.run.id)} AND lease_token = ${p.add(lease.token)} RETURNING id`,
          p.values,
        );
        // Stale token: nothing was written, so committing the empty transaction is harmless.
        if (rows.length === 0) return false;
        await applyRelated(q, patch, events, now);
        return true;
      });
    },

    async getRunByCallbackToken(token) {
      const { rows } = await pool.query(
        `SELECT ${RUN_COLUMNS} FROM ${s}.runs r
         WHERE r.callback_token = $1 AND r.status = 'waiting'`,
        [token],
      );
      return rows[0] ? toRun(rows[0]) : null;
    },

    async resumeByToken(token, resume, now, event) {
      const row = await resumeWhere(
        "r.callback_token = $1 AND (r.callback_expires_at IS NULL OR r.callback_expires_at > $2)",
        [token, now],
        resume,
        now,
        event,
      );
      return row ? toRun(row) : null;
    },

    async resumeRun(runId, expectCurrentStep, resume, now, event) {
      const row = await resumeWhere(
        "r.id = $1 AND r.current_step = $2",
        [runId, expectCurrentStep],
        resume,
        now,
        event,
      );
      return row !== undefined;
    },

    async requestCancel(tenantId, runId, now, request) {
      const info = request && Object.keys(request).length > 0 ? JSON.stringify(request) : null;
      // SET expressions read the old row: only the first request's who and why are kept.
      const { rows } = await pool.query(
        `UPDATE ${s}.runs SET cancel_requested_at = coalesce(cancel_requested_at, $3),
           cancel_request = CASE WHEN cancel_requested_at IS NULL THEN $4::jsonb
             ELSE cancel_request END,
           updated_at = $3
         WHERE id = $1 AND tenant_id = $2 AND status NOT IN ('completed', 'failed', 'cancelled')
         RETURNING id`,
        [runId, tenantId, now, info],
      );
      return rows.length > 0;
    },

    async updateRunUnleased(tenantId, runId, expect, patch, events, now) {
      return tx(async (q) => {
        const p = new Params();
        const sets = [...patchAssignments(patch, now, p), CLEAR_LEASE];
        const nowParam = p.add(now);
        const { rows } = await q.query(
          `UPDATE ${s}.runs SET ${sets.join(", ")}
           WHERE id = ${p.add(runId)} AND tenant_id = ${p.add(tenantId)}
             AND status = ANY(${p.add(expect.status)}::text[])
             AND (lease_until IS NULL OR lease_until < ${nowParam})
           RETURNING id`,
          p.values,
        );
        if (rows.length === 0) return false;
        await applyRelated(q, patch, events, now);
        return true;
      });
    },

    async appendEvents(events) {
      if (events.length === 0) return;
      await tx((q) => appendIn(q, events));
    },

    async listEvents(tenantId, runId) {
      const { rows } = await pool.query(
        `SELECT ${EVENT_COLUMNS} FROM ${s}.run_events e
         WHERE e.run_id = $1 AND e.tenant_id = $2 ORDER BY e.seq`,
        [runId, tenantId],
      );
      return rows.map(toEvent);
    },

    async recordDedupeKey(tenantId, key, now, ttlMs) {
      const { rows } = await pool.query(
        `INSERT INTO ${s}.dedupe_keys AS d (tenant_id, key, expires_at) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, key) DO UPDATE SET expires_at = EXCLUDED.expires_at
         WHERE d.expires_at <= $4
         RETURNING 1`,
        [tenantId, key, now + ttlMs, now],
      );
      return rows.length > 0;
    },
  };
}
