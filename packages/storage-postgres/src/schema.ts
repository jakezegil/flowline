/**
 * The Postgres schema of the adapter, as idempotent DDL statements.
 *
 * @module
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate a schema name and return it as a quoted SQL identifier.
 *
 * @throws {Error} if the name is not a plain identifier (letters, digits, `_`; max 63 chars).
 */
export function quoteSchema(schema: string): string {
  if (!IDENT.test(schema) || schema.length > 63) {
    throw new Error(`Invalid Postgres schema name ${JSON.stringify(schema)}`);
  }
  return `"${schema}"`;
}

/**
 * The DDL creating every table and index in `schema` (already quoted), one statement per entry.
 * Every statement is `IF NOT EXISTS`, so running them again is a no-op.
 */
export function schemaStatements(s: string): string[] {
  return [
    `CREATE SCHEMA IF NOT EXISTS ${s}`,
    `CREATE TABLE IF NOT EXISTS ${s}.workflow_versions (
      tenant_id text NOT NULL,
      workflow_id text NOT NULL,
      version integer NOT NULL,
      doc jsonb NOT NULL,
      trigger_type text NOT NULL,
      created_by text NOT NULL,
      created_at bigint NOT NULL,
      PRIMARY KEY (tenant_id, workflow_id, version)
    )`,
    `CREATE TABLE IF NOT EXISTS ${s}.workflows (
      tenant_id text NOT NULL,
      workflow_id text NOT NULL,
      name text NOT NULL,
      latest_version integer NOT NULL,
      published_version integer,
      published_at bigint,
      updated_at bigint NOT NULL,
      PRIMARY KEY (tenant_id, workflow_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${s}.workflow_audit (
      id bigserial PRIMARY KEY,
      tenant_id text NOT NULL,
      workflow_id text NOT NULL,
      version integer NOT NULL,
      action text NOT NULL,
      actor text NOT NULL,
      at bigint NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS workflow_audit_workflow_idx
      ON ${s}.workflow_audit (tenant_id, workflow_id, id)`,
    `CREATE TABLE IF NOT EXISTS ${s}.runs (
      id text PRIMARY KEY,
      tenant_id text NOT NULL,
      workflow_id text NOT NULL,
      version integer NOT NULL,
      status text NOT NULL,
      trigger jsonb,
      journal jsonb NOT NULL DEFAULT '{}'::jsonb,
      attempt integer NOT NULL,
      current_step text,
      wake_at bigint,
      wait_reason text,
      callback_token text UNIQUE,
      callback_expires_at bigint,
      resume jsonb,
      parent jsonb,
      output jsonb,
      error jsonb,
      started_by jsonb NOT NULL,
      lease_owner text,
      lease_until bigint,
      lease_token text,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS runs_status_wake_at_idx ON ${s}.runs (status, wake_at)`,
    `CREATE INDEX IF NOT EXISTS runs_status_lease_until_idx ON ${s}.runs (status, lease_until)`,
    `CREATE INDEX IF NOT EXISTS runs_tenant_workflow_created_idx
      ON ${s}.runs (tenant_id, workflow_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS ${s}.run_events (
      id text NOT NULL,
      run_id text NOT NULL,
      tenant_id text NOT NULL,
      seq integer NOT NULL,
      type text NOT NULL,
      step_path text,
      at bigint NOT NULL,
      worker_id text,
      data jsonb,
      PRIMARY KEY (run_id, seq)
    )`,
    `CREATE TABLE IF NOT EXISTS ${s}.dedupe_keys (
      tenant_id text NOT NULL,
      key text NOT NULL,
      expires_at bigint NOT NULL,
      PRIMARY KEY (tenant_id, key)
    )`,
  ];
}
