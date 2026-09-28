/**
 * In-memory {@link StorageAdapter} for tests, examples and single-process development.
 * Data lives only as long as the adapter instance.
 *
 * @module
 */
import type {
  ResumeInfo,
  RunEvent,
  RunSummary,
  WorkflowDoc,
  WorkflowSummary,
  WorkflowVersion,
} from "@flowkit/core";
import {
  FlowkitStorageError,
  type Lease,
  type NewRun,
  type NewRunEvent,
  type ResumeEvent,
  type Run,
  type RunPatch,
  type StorageAdapter,
  stoppedAtOf,
  type WorkflowAuditEntry,
} from "@flowkit/engine";

/** Package version. */
export const VERSION = "0.1.0";

interface StoredRun {
  run: Run;
  token?: string;
}

interface Published {
  version: number;
  publishedAt: number;
}

const clone = <T>(value: T): T => structuredClone(value);
const FINISHED: ReadonlySet<Run["status"]> = new Set(["completed", "failed", "cancelled"]);
const wfKey = (tenantId: string, workflowId: string) => `${tenantId}\u0000${workflowId}`;

/** Set `key` from a patch value: `undefined` keeps, `null` deletes, anything else sets. */
function setOpt<K extends keyof Run>(run: Run, key: K, value: Run[K] | null | undefined): void {
  if (value === undefined) return;
  if (value === null) delete run[key];
  else run[key] = clone(value);
}

/** Apply the run's own fields of `patch` to `stored` (in place). */
function applyPatch(stored: StoredRun, patch: RunPatch, now: number): void {
  const run = stored.run;
  if (patch.status !== undefined) run.status = patch.status;
  if (patch.journal) {
    for (const [key, entry] of Object.entries(patch.journal)) {
      // Own-property writes: keys like `__proto__` must stay plain data keys.
      if (entry === null) delete run.journal[key];
      else {
        Object.defineProperty(run.journal, key, {
          value: clone(entry),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }
  }
  if (patch.attempt !== undefined) run.attempt = patch.attempt;
  setOpt(run, "currentStep", patch.currentStep);
  setOpt(run, "wakeAt", patch.wakeAt);
  setOpt(run, "waitReason", patch.waitReason);
  setOpt(run, "callbackToken", patch.callbackToken);
  setOpt(run, "callbackExpiresAt", patch.callbackExpiresAt);
  setOpt(run, "resume", patch.resume);
  if (patch.output !== undefined) run.output = clone(patch.output);
  setOpt(run, "error", patch.error);
  setOpt(run, "cancelRequestedAt", patch.cancelRequestedAt);
  // Only a running run can hold a lease.
  if (patch.release || (patch.status !== undefined && patch.status !== "running")) {
    clearLease(stored);
  }
  run.updatedAt = now;
}

function clearLease(stored: StoredRun): void {
  delete stored.run.leaseOwner;
  delete stored.run.leaseUntil;
  delete stored.token;
}

/** The waiting → queued transition shared by resumeByToken, resumeRun and wakeParent. */
function resumeTransition(run: Run, resume: ResumeInfo, now: number): void {
  run.status = "queued";
  run.resume = clone(resume);
  delete run.wakeAt;
  delete run.callbackToken;
  delete run.callbackExpiresAt;
  run.updatedAt = now;
}

function toSummary(run: Run): RunSummary {
  const summary: RunSummary = {
    id: run.id,
    workflowId: run.workflowId,
    version: run.version,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedBy: clone(run.startedBy),
  };
  if (run.error) summary.error = clone(run.error);
  const stoppedAt = stoppedAtOf(run);
  if (stoppedAt !== undefined) summary.stoppedAt = stoppedAt;
  return summary;
}

/**
 * Create an in-memory {@link StorageAdapter}. Every read and write copies values with
 * `structuredClone`, so callers can never mutate stored state. Each method runs to completion
 * without yielding between its checks and its writes, which makes every method atomic within the
 * process. Not shared across processes.
 */
export function createMemoryStorage(): StorageAdapter {
  const versions = new Map<string, WorkflowVersion[]>();
  const published = new Map<string, Published>();
  const audit: WorkflowAuditEntry[] = [];
  const runs = new Map<string, StoredRun>();
  const events = new Map<string, RunEvent[]>();
  const dedupe = new Map<string, number>();

  const newStoredRun = (input: NewRun, now: number): StoredRun => {
    const run: Run = { ...clone(input), createdAt: now, updatedAt: now };
    delete run.leaseOwner;
    delete run.leaseUntil;
    return { run };
  };

  const append = (list: NewRunEvent[]): void => {
    for (const e of list) {
      const existing = events.get(e.runId) ?? [];
      const last = existing[existing.length - 1];
      existing.push({ ...clone(e), id: crypto.randomUUID(), seq: (last?.seq ?? 0) + 1 });
      events.set(e.runId, existing);
    }
  };

  /**
   * Validate `patch.createChild` without writing. Returns whether the child must be inserted
   * (`false` when it already exists in the same tenant).
   *
   * @throws {FlowkitStorageError} if the child id belongs to another tenant.
   */
  const checkChild = (patch: RunPatch): boolean => {
    const child = patch.createChild;
    if (!child) return false;
    const existing = runs.get(child.id);
    if (!existing) return true;
    if (existing.run.tenantId !== child.tenantId) {
      throw new FlowkitStorageError(`Run id "${child.id}" already belongs to another tenant`);
    }
    return false;
  };

  /**
   * The shared tail of `commit` and `updateRunUnleased`, run after all checks passed: insert the
   * child, wake the parent (no-op unless its preconditions hold) and append the events — skipping
   * the child's events when the child already existed.
   */
  const applyRelated = (
    patch: RunPatch,
    insertChild: boolean,
    newEvents: NewRunEvent[],
    now: number,
  ): void => {
    const child = patch.createChild;
    if (child && insertChild) runs.set(child.id, newStoredRun(child, now));
    const wake = patch.wakeParent;
    if (wake) {
      const parent = runs.get(wake.runId)?.run;
      const entry =
        parent && Object.hasOwn(parent.journal, wake.stepPath)
          ? parent.journal[wake.stepPath]
          : undefined;
      if (
        parent?.status === "waiting" &&
        parent.currentStep === wake.stepPath &&
        entry?.status === "suspended" &&
        entry.pending?.childRunId === wake.childRunId
      ) {
        resumeTransition(parent, wake.resume, now);
      }
    }
    append(child && !insertChild ? newEvents.filter((e) => e.runId !== child.id) : newEvents);
  };

  /** Append a resume's event to `run`, completed with the run's identity (see `ResumeEvent`). */
  const appendResumeEvent = (run: Run, event: ResumeEvent | undefined, now: number): void => {
    if (!event) return;
    const e: NewRunEvent = { runId: run.id, tenantId: run.tenantId, type: event.type, at: now };
    if (run.currentStep !== undefined) e.stepPath = run.currentStep;
    if (event.data !== undefined) e.data = event.data;
    append([e]);
  };

  const isClaimable = (run: Run, now: number): boolean => {
    if (run.status === "queued") return true;
    if (run.status === "waiting") return run.wakeAt !== undefined && run.wakeAt <= now;
    if (run.status === "running") return run.leaseUntil === undefined || run.leaseUntil < now;
    return false;
  };

  return {
    async saveWorkflowVersion(tenantId: string, doc: WorkflowDoc, actor: string, now: number) {
      const key = wfKey(tenantId, doc.id);
      const list = versions.get(key) ?? [];
      const version: WorkflowVersion = {
        workflowId: doc.id,
        tenantId,
        version: list.length + 1,
        doc: clone(doc),
        createdBy: actor,
        createdAt: now,
      };
      list.push(version);
      versions.set(key, list);
      return clone(version);
    },

    async getWorkflowVersion(tenantId, workflowId, version) {
      const v = versions.get(wfKey(tenantId, workflowId))?.[version - 1];
      return v ? clone(v) : null;
    },

    async getLatestVersion(tenantId, workflowId) {
      const list = versions.get(wfKey(tenantId, workflowId));
      const v = list?.[list.length - 1];
      return v ? clone(v) : null;
    },

    async getPublishedVersion(tenantId, workflowId) {
      const key = wfKey(tenantId, workflowId);
      const p = published.get(key);
      const v = p ? versions.get(key)?.[p.version - 1] : undefined;
      return v ? clone(v) : null;
    },

    async publishVersion(tenantId, workflowId, version, now) {
      const key = wfKey(tenantId, workflowId);
      if (!versions.get(key)?.[version - 1]) {
        throw new Error(`Workflow ${workflowId} has no version ${version}`);
      }
      published.set(key, { version, publishedAt: now });
    },

    async listWorkflows(tenantId) {
      const out: WorkflowSummary[] = [];
      for (const [key, list] of versions) {
        const latest = list[list.length - 1];
        if (!latest || latest.tenantId !== tenantId) continue;
        const p = published.get(key);
        out.push({
          id: latest.workflowId,
          name: latest.doc.name,
          triggerType: latest.doc.trigger.type,
          latestVersion: latest.version,
          publishedVersion: p?.version ?? null,
          publishedAt: p?.publishedAt ?? null,
          updatedAt: latest.createdAt,
        });
      }
      return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },

    async listPublished(filter) {
      const out: WorkflowVersion[] = [];
      for (const [key, p] of published) {
        const v = versions.get(key)?.[p.version - 1];
        if (!v) continue;
        if (filter.tenantId !== undefined && v.tenantId !== filter.tenantId) continue;
        if (filter.triggerType !== undefined && v.doc.trigger.type !== filter.triggerType) continue;
        out.push(clone(v));
      }
      return out;
    },

    async appendWorkflowAudit(e) {
      audit.push(clone(e));
    },

    async listWorkflowAudit(tenantId, workflowId) {
      return audit
        .filter((e) => e.tenantId === tenantId && e.workflowId === workflowId)
        .map((e) => clone(e));
    },

    async createRun(run, newEvents, now) {
      const existing = runs.get(run.id);
      if (existing) {
        if (existing.run.tenantId !== run.tenantId) {
          throw new FlowkitStorageError(`Run id "${run.id}" already belongs to another tenant`);
        }
        return clone(existing.run);
      }
      const stored = newStoredRun(run, now);
      runs.set(run.id, stored);
      append(newEvents);
      return clone(stored.run);
    },

    async getRun(tenantId, runId) {
      const stored = runs.get(runId);
      return stored && stored.run.tenantId === tenantId ? clone(stored.run) : null;
    },

    async getRunById(runId) {
      const stored = runs.get(runId);
      return stored ? clone(stored.run) : null;
    },

    async listRuns(tenantId, f) {
      const limit = f.limit ?? 50;
      return [...runs.values()]
        .map((s) => s.run)
        .filter(
          (r) =>
            r.tenantId === tenantId &&
            (f.workflowId === undefined || r.workflowId === f.workflowId) &&
            (f.status === undefined || r.status === f.status) &&
            (f.topLevel !== true || r.startedBy.kind !== "subflow"),
        )
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
        .slice(0, limit)
        .map(toSummary);
    },

    async claimRun({ workerId, leaseMs, now }) {
      let best: StoredRun | undefined;
      let bestKey = 0;
      for (const stored of runs.values()) {
        const run = stored.run;
        if (!isClaimable(run, now)) continue;
        const key = run.wakeAt ?? run.updatedAt;
        if (
          !best ||
          key < bestKey ||
          (key === bestKey &&
            (run.createdAt < best.run.createdAt ||
              (run.createdAt === best.run.createdAt && run.id < best.run.id)))
        ) {
          best = stored;
          bestKey = key;
        }
      }
      if (!best) return null;
      const token = crypto.randomUUID();
      best.run.status = "running";
      best.run.leaseOwner = workerId;
      best.run.leaseUntil = now + leaseMs;
      best.run.updatedAt = now;
      best.token = token;
      return { run: clone(best.run), token };
    },

    async renewLease(lease: Lease, leaseMs, now) {
      const stored = runs.get(lease.run.id);
      if (!stored || stored.token === undefined || stored.token !== lease.token) return false;
      stored.run.leaseUntil = now + leaseMs;
      stored.run.updatedAt = now;
      return true;
    },

    async commit(lease, patch, newEvents, now) {
      const stored = runs.get(lease.run.id);
      if (!stored || stored.token === undefined || stored.token !== lease.token) return false;
      const insertChild = checkChild(patch);
      applyPatch(stored, patch, now);
      applyRelated(patch, insertChild, newEvents, now);
      return true;
    },

    async resumeByToken(token, resume, now, event) {
      for (const stored of runs.values()) {
        const run = stored.run;
        if (run.status !== "waiting" || run.callbackToken !== token) continue;
        if (run.callbackExpiresAt !== undefined && run.callbackExpiresAt <= now) return null;
        resumeTransition(run, resume, now);
        appendResumeEvent(run, event, now);
        return clone(run);
      }
      return null;
    },

    async resumeRun(runId, expectCurrentStep, resume, now, event) {
      const run = runs.get(runId)?.run;
      if (run?.status !== "waiting") return false;
      if (run.currentStep !== expectCurrentStep) return false;
      resumeTransition(run, resume, now);
      appendResumeEvent(run, event, now);
      return true;
    },

    async requestCancel(tenantId, runId, now) {
      const run = runs.get(runId)?.run;
      if (!run || run.tenantId !== tenantId || FINISHED.has(run.status)) return false;
      run.cancelRequestedAt ??= now;
      run.updatedAt = now;
      return true;
    },

    async updateRunUnleased(tenantId, runId, expect, patch, newEvents, now) {
      const stored = runs.get(runId);
      if (!stored || stored.run.tenantId !== tenantId) return false;
      if (!expect.status.includes(stored.run.status)) return false;
      if (stored.run.leaseUntil !== undefined && stored.run.leaseUntil >= now) return false;
      const insertChild = checkChild(patch);
      applyPatch(stored, patch, now);
      clearLease(stored);
      applyRelated(patch, insertChild, newEvents, now);
      return true;
    },

    async appendEvents(newEvents) {
      append(newEvents);
    },

    async listEvents(tenantId, runId) {
      return (events.get(runId) ?? []).filter((e) => e.tenantId === tenantId).map((e) => clone(e));
    },

    async recordDedupeKey(tenantId, key, now, ttlMs) {
      const k = wfKey(tenantId, key);
      const expiresAt = dedupe.get(k);
      if (expiresAt !== undefined && expiresAt > now) return false;
      dedupe.set(k, now + ttlMs);
      return true;
    },
  };
}
