import type { JournalEntry, RunEventType, WorkflowDoc } from "@flowkit/core";
import { describe, expect, it } from "vitest";
import type { Lease, NewRun, NewRunEvent, StorageAdapter } from "../storage";

/** What a conformance factory returns: a fresh, empty adapter and an optional cleanup. */
export interface ConformanceFixture {
  /** A fresh adapter with no data. */
  storage: StorageAdapter;
  /** Called after each test case, even when it fails. */
  cleanup?: () => Promise<void>;
}

const T1 = "tenant-1";
const T2 = "tenant-2";

function doc(id: string, triggerType = "manual", name = `Workflow ${id}`): WorkflowDoc {
  return { id, name, trigger: { type: triggerType, config: {} }, steps: [] };
}

function newRun(id: string, overrides: Partial<NewRun> = {}): NewRun {
  return {
    id,
    tenantId: T1,
    workflowId: "wf",
    version: 1,
    status: "queued",
    trigger: { hello: "world" },
    journal: {},
    attempt: 1,
    startedBy: { kind: "manual" },
    ...overrides,
  };
}

function ev(runId: string, type: RunEventType, at = 1, tenantId = T1): NewRunEvent {
  return { runId, tenantId, type, at };
}

function done(output: unknown, at = 1): JournalEntry {
  return { status: "done", output, at, startedAt: at, attempts: 1 };
}

async function claimOrFail(storage: StorageAdapter, now: number, workerId = "w1"): Promise<Lease> {
  const lease = await storage.claimRun({ workerId, leaseMs: 1000, now });
  if (!lease) throw new Error("expected a claimable run");
  return lease;
}

/**
 * Register a Vitest suite that checks a {@link StorageAdapter} against the storage contract.
 * Every test case receives a fresh adapter from `make()` and calls its `cleanup` afterwards. The
 * suite uses only the public interface and explicit `now` values, so it works for any adapter.
 *
 * @example
 * ```ts
 * import { runStorageConformance } from "@flowkit/engine/testing";
 * runStorageConformance("memory", async () => ({ storage: createMemoryStorage() }));
 * ```
 *
 * @param name Suite name shown in the test report.
 * @param make Factory creating a fresh, empty adapter per test case.
 */
export function runStorageConformance(name: string, make: () => Promise<ConformanceFixture>): void {
  const test = (title: string, fn: (storage: StorageAdapter) => Promise<void>) =>
    it(title, async () => {
      const { storage, cleanup } = await make();
      try {
        await fn(storage);
      } finally {
        await cleanup?.();
      }
    });

  describe(`storage conformance: ${name}`, () => {
    describe("workflow versions", () => {
      test("save increments the version per workflow", async (s) => {
        const a1 = await s.saveWorkflowVersion(T1, doc("a"), "u1", 10);
        const a2 = await s.saveWorkflowVersion(T1, doc("a", "manual", "Renamed"), "u2", 20);
        const b1 = await s.saveWorkflowVersion(T1, doc("b"), "u1", 30);
        expect(a1).toMatchObject({ workflowId: "a", tenantId: T1, version: 1, createdBy: "u1" });
        expect(a1.createdAt).toBe(10);
        expect(a2.version).toBe(2);
        expect(a2.createdBy).toBe("u2");
        expect(b1.version).toBe(1);
        expect(await s.getWorkflowVersion(T1, "a", 1)).toEqual(a1);
        expect((await s.getWorkflowVersion(T1, "a", 2))?.doc.name).toBe("Renamed");
        expect(await s.getWorkflowVersion(T1, "a", 3)).toBeNull();
        expect((await s.getLatestVersion(T1, "a"))?.version).toBe(2);
        expect(await s.getLatestVersion(T1, "missing")).toBeNull();
        expect(await s.getPublishedVersion(T1, "a")).toBeNull();
      });

      test("versions are immutable", async (s) => {
        const input = doc("a");
        const saved = await s.saveWorkflowVersion(T1, input, "u1", 10);
        input.name = "mutated input";
        saved.doc.name = "mutated result";
        saved.doc.steps.push({ id: "x", type: "t", config: {} });
        const read = await s.getWorkflowVersion(T1, "a", 1);
        expect(read?.doc).toEqual(doc("a"));
        if (read) read.doc.name = "mutated read";
        expect((await s.getLatestVersion(T1, "a"))?.doc).toEqual(doc("a"));
      });

      test("publish and listPublished by trigger type", async (s) => {
        await s.saveWorkflowVersion(T1, doc("a", "cron"), "u", 1);
        await s.saveWorkflowVersion(T1, doc("a", "manual"), "u", 2);
        await s.saveWorkflowVersion(T1, doc("b", "manual"), "u", 3);
        await s.saveWorkflowVersion(T2, doc("c", "cron"), "u", 4);
        await s.saveWorkflowVersion(T1, doc("d", "cron"), "u", 5); // never published

        await s.publishVersion(T1, "a", 1, 100);
        await s.publishVersion(T1, "b", 1, 101);
        await s.publishVersion(T2, "c", 1, 102);

        expect((await s.getPublishedVersion(T1, "a"))?.version).toBe(1);
        const cron = await s.listPublished({ triggerType: "cron" });
        expect(cron.map((v) => `${v.tenantId}/${v.workflowId}@${v.version}`).sort()).toEqual([
          `${T1}/a@1`,
          `${T2}/c@1`,
        ]);
        const all = await s.listPublished({});
        expect(all.map((v) => v.workflowId).sort()).toEqual(["a", "b", "c"]);
        const t1Manual = await s.listPublished({ tenantId: T1, triggerType: "manual" });
        expect(t1Manual.map((v) => v.workflowId)).toEqual(["b"]);

        // Re-publishing replaces the published version; filters follow the published doc.
        await s.publishVersion(T1, "a", 2, 200);
        expect((await s.getPublishedVersion(T1, "a"))?.version).toBe(2);
        const cron2 = await s.listPublished({ triggerType: "cron" });
        expect(cron2.map((v) => v.workflowId)).toEqual(["c"]);

        await expect(s.publishVersion(T1, "a", 9, 300)).rejects.toThrow();
        await expect(s.publishVersion(T1, "zzz", 1, 300)).rejects.toThrow();
        expect((await s.getPublishedVersion(T1, "a"))?.version).toBe(2);
      });

      test("listWorkflows summarises each workflow", async (s) => {
        await s.saveWorkflowVersion(T1, doc("b", "cron", "B one"), "u", 10);
        await s.saveWorkflowVersion(T1, doc("a", "cron", "A one"), "u", 20);
        await s.saveWorkflowVersion(T1, doc("a", "manual", "A two"), "u", 30);
        await s.publishVersion(T1, "a", 1, 40);
        expect(await s.listWorkflows(T1)).toEqual([
          {
            id: "a",
            name: "A two",
            triggerType: "manual",
            latestVersion: 2,
            publishedVersion: 1,
            publishedAt: 40,
            updatedAt: 30,
          },
          {
            id: "b",
            name: "B one",
            triggerType: "cron",
            latestVersion: 1,
            publishedVersion: null,
            publishedAt: null,
            updatedAt: 10,
          },
        ]);
      });

      test("workflow audit entries are listed in append order", async (s) => {
        await s.appendWorkflowAudit({
          tenantId: T1,
          workflowId: "a",
          version: 1,
          action: "saved",
          actor: "u1",
          at: 10,
        });
        await s.appendWorkflowAudit({
          tenantId: T1,
          workflowId: "a",
          version: 1,
          action: "published",
          actor: "u2",
          at: 20,
        });
        await s.appendWorkflowAudit({
          tenantId: T1,
          workflowId: "b",
          version: 1,
          action: "saved",
          actor: "u1",
          at: 30,
        });
        const entries = await s.listWorkflowAudit(T1, "a");
        expect(entries.map((e) => [e.action, e.actor, e.at])).toEqual([
          ["saved", "u1", 10],
          ["published", "u2", 20],
        ]);
        expect(entries[0]).toEqual({
          tenantId: T1,
          workflowId: "a",
          version: 1,
          action: "saved",
          actor: "u1",
          at: 10,
        });
      });
    });

    test("tenant scoping on every read", async (s) => {
      await s.saveWorkflowVersion(T1, doc("a"), "u", 1);
      await s.publishVersion(T1, "a", 1, 2);
      await s.appendWorkflowAudit({
        tenantId: T1,
        workflowId: "a",
        version: 1,
        action: "saved",
        actor: "u",
        at: 1,
      });
      await s.createRun(newRun("r1", { workflowId: "a" }), [ev("r1", "run.started")], 3);

      expect(await s.getWorkflowVersion(T2, "a", 1)).toBeNull();
      expect(await s.getLatestVersion(T2, "a")).toBeNull();
      expect(await s.getPublishedVersion(T2, "a")).toBeNull();
      expect(await s.listWorkflows(T2)).toEqual([]);
      expect(await s.listPublished({ tenantId: T2 })).toEqual([]);
      expect(await s.listWorkflowAudit(T2, "a")).toEqual([]);
      expect(await s.getRun(T2, "r1")).toBeNull();
      expect(await s.listRuns(T2, {})).toEqual([]);
      expect(await s.listEvents(T2, "r1")).toEqual([]);
      expect(await s.updateRunUnleased(T2, "r1", { status: "cancelled" }, [], 4)).toBe(false);
      expect((await s.getRun(T1, "r1"))?.status).toBe("queued");

      // Same workflow id in another tenant is an independent version sequence.
      expect((await s.saveWorkflowVersion(T2, doc("a"), "u", 5)).version).toBe(1);
      expect((await s.saveWorkflowVersion(T1, doc("a"), "u", 6)).version).toBe(2);

      // Dedupe keys are per tenant.
      expect(await s.recordDedupeKey(T1, "k", 10, 1000)).toBe(true);
      expect(await s.recordDedupeKey(T2, "k", 10, 1000)).toBe(true);

      // getRunById is deliberately not tenant-scoped.
      expect((await s.getRunById("r1"))?.tenantId).toBe(T1);
      expect(await s.getRunById("nope")).toBeNull();
    });

    describe("runs", () => {
      test("createRun stores the run with timestamps and its events", async (s) => {
        const created = await s.createRun(
          newRun("r1", { leaseOwner: "ignored", leaseUntil: 999_999 }),
          [ev("r1", "run.started", 5), ev("r1", "step.started", 6)],
          100,
        );
        expect(created).toMatchObject({ id: "r1", tenantId: T1, status: "queued" });
        expect(created.createdAt).toBe(100);
        expect(created.updatedAt).toBe(100);
        expect(created.leaseOwner).toBeUndefined();
        expect(created.leaseUntil).toBeUndefined();
        expect(await s.getRun(T1, "r1")).toEqual(created);
        const events = await s.listEvents(T1, "r1");
        expect(events.map((e) => [e.seq, e.type, e.at])).toEqual([
          [1, "run.started", 5],
          [2, "step.started", 6],
        ]);
        // New runs are claimable despite lease fields in the input.
        expect((await s.claimRun({ workerId: "w", leaseMs: 10, now: 101 }))?.run.id).toBe("r1");
      });

      test("createRun with an existing id returns the existing run without duplicate events", async (s) => {
        const first = await s.createRun(newRun("r1"), [ev("r1", "run.started")], 100);
        const second = await s.createRun(
          newRun("r1", { status: "waiting", trigger: "other" }),
          [ev("r1", "run.started"), ev("r1", "step.started")],
          200,
        );
        expect(second).toEqual(first);
        expect(await s.getRun(T1, "r1")).toEqual(first);
        expect(await s.listEvents(T1, "r1")).toHaveLength(1);
      });

      test("returned runs are isolated from storage", async (s) => {
        const input = newRun("r1", { journal: { a: done(1) } });
        const created = await s.createRun(input, [], 1);
        input.trigger = "mutated";
        created.journal.b = done(2);
        const read = await s.getRun(T1, "r1");
        expect(read?.trigger).toEqual({ hello: "world" });
        expect(Object.keys(read?.journal ?? {})).toEqual(["a"]);
        if (read) read.status = "failed";
        expect((await s.getRun(T1, "r1"))?.status).toBe("queued");
      });

      test("listRuns returns newest first and applies filters and limit", async (s) => {
        await s.createRun(newRun("r1", { workflowId: "a" }), [], 10);
        await s.createRun(newRun("r2", { workflowId: "b" }), [], 20);
        await s.createRun(
          newRun("r3", {
            workflowId: "a",
            status: "failed",
            error: { message: "boom" },
          }),
          [],
          30,
        );
        await s.createRun(newRun("r4", { workflowId: "a" }), [], 40);

        const all = await s.listRuns(T1, {});
        expect(all.map((r) => r.id)).toEqual(["r4", "r3", "r2", "r1"]);
        expect(all[1]).toEqual({
          id: "r3",
          workflowId: "a",
          version: 1,
          status: "failed",
          createdAt: 30,
          updatedAt: 30,
          error: { message: "boom" },
          startedBy: { kind: "manual" },
        });
        expect((await s.listRuns(T1, { workflowId: "a" })).map((r) => r.id)).toEqual([
          "r4",
          "r3",
          "r1",
        ]);
        expect((await s.listRuns(T1, { status: "queued" })).map((r) => r.id)).toEqual([
          "r4",
          "r2",
          "r1",
        ]);
        expect(
          (await s.listRuns(T1, { workflowId: "a", status: "queued" })).map((r) => r.id),
        ).toEqual(["r4", "r1"]);
        expect((await s.listRuns(T1, { limit: 2 })).map((r) => r.id)).toEqual(["r4", "r3"]);
      });

      test("listRuns defaults to 50 rows", async (s) => {
        for (let i = 0; i < 55; i++) {
          await s.createRun(newRun(`r${String(i).padStart(2, "0")}`), [], i);
        }
        const rows = await s.listRuns(T1, {});
        expect(rows).toHaveLength(50);
        expect(rows[0]?.id).toBe("r54");
      });
    });

    describe("leases", () => {
      test("claimRun leases a queued run and returns null when nothing is runnable", async (s) => {
        expect(await s.claimRun({ workerId: "w1", leaseMs: 1000, now: 0 })).toBeNull();
        await s.createRun(newRun("r1"), [], 10);
        const lease = await claimOrFail(s, 50);
        expect(typeof lease.token).toBe("string");
        expect(lease.token.length).toBeGreaterThan(0);
        expect(lease.run).toMatchObject({
          id: "r1",
          status: "running",
          leaseOwner: "w1",
          leaseUntil: 1050,
          updatedAt: 50,
          trigger: { hello: "world" },
        });
        expect(await s.getRun(T1, "r1")).toEqual(lease.run);
      });

      test("claimRun is exclusive under 20 concurrent claimers on 5 runs", async (s) => {
        for (let i = 0; i < 5; i++) await s.createRun(newRun(`r${i}`), [], i);
        const results = await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            s.claimRun({ workerId: `w${i}`, leaseMs: 10_000, now: 100 }),
          ),
        );
        const claimed = results.filter((r): r is Lease => r !== null).map((l) => l.run.id);
        expect(claimed).toHaveLength(5);
        expect([...claimed].sort()).toEqual(["r0", "r1", "r2", "r3", "r4"]);
        const tokens = new Set(results.filter((r) => r !== null).map((l) => l?.token));
        expect(tokens.size).toBe(5);
        // Unexpired leases are not claimable.
        expect(await s.claimRun({ workerId: "late", leaseMs: 10_000, now: 5_000 })).toBeNull();
      });

      test("claimRun prefers the oldest wakeAt/updatedAt so overdue timers are not starved", async (s) => {
        await s.createRun(newRun("queued-new"), [], 500);
        await s.createRun(newRun("timer", { status: "waiting", wakeAt: 100 }), [], 600);
        await s.createRun(newRun("queued-old"), [], 200);
        const order: string[] = [];
        for (let i = 0; i < 3; i++) order.push((await claimOrFail(s, 1000)).run.id);
        expect(order).toEqual(["timer", "queued-old", "queued-new"]);
      });

      test("waiting run is not claimable before wakeAt and claimable at wakeAt", async (s) => {
        await s.createRun(
          newRun("r1", { status: "waiting", wakeAt: 500, waitReason: "timer" }),
          [],
          10,
        );
        await s.createRun(newRun("r2", { status: "waiting", waitReason: "callback" }), [], 10);
        expect(await s.claimRun({ workerId: "w", leaseMs: 100, now: 499 })).toBeNull();
        const lease = await claimOrFail(s, 500);
        expect(lease.run.id).toBe("r1");
        expect(lease.run.status).toBe("running");
        expect(lease.run.waitReason).toBe("timer");
        // A waiting run without wakeAt is never claimable (r1 is still leased until 600).
        expect(await s.claimRun({ workerId: "w", leaseMs: 100, now: 550 })).toBeNull();
      });

      test("expired lease is reclaimable and the old token's commit writes nothing", async (s) => {
        await s.createRun(newRun("r1", { journal: { a: done(1) } }), [ev("r1", "run.started")], 0);
        const old = await claimOrFail(s, 10, "w1"); // leaseUntil 1010
        expect(await s.claimRun({ workerId: "w2", leaseMs: 1000, now: 1010 })).toBeNull();
        const fresh = await claimOrFail(s, 1011, "w2");
        expect(fresh.run.id).toBe("r1");
        expect(fresh.token).not.toBe(old.token);
        expect(fresh.run.leaseOwner).toBe("w2");

        const before = await s.getRun(T1, "r1");
        const ok = await s.commit(
          old,
          {
            status: "completed",
            journal: { a: null, b: done(2) },
            output: "x",
            release: true,
            createChild: newRun("child", { parent: { runId: "r1", stepPath: "a" } }),
          },
          [ev("r1", "run.completed")],
          1020,
        );
        expect(ok).toBe(false);
        expect(await s.getRun(T1, "r1")).toEqual(before);
        expect(await s.getRun(T1, "child")).toBeNull();
        expect(await s.listEvents(T1, "r1")).toHaveLength(1);
        expect(await s.renewLease(old, 1000, 1020)).toBe(false);

        expect(await s.commit(fresh, { status: "completed", release: true }, [], 1030)).toBe(true);
        expect((await s.getRun(T1, "r1"))?.status).toBe("completed");
      });

      test("renewLease extends a current lease", async (s) => {
        await s.createRun(newRun("r1"), [], 0);
        const lease = await claimOrFail(s, 0); // until 1000
        expect(await s.renewLease(lease, 5000, 900)).toBe(true); // until 5900
        expect((await s.getRun(T1, "r1"))?.leaseUntil).toBe(5900);
        expect(await s.claimRun({ workerId: "w2", leaseMs: 10, now: 2000 })).toBeNull();
        // Expired but not reclaimed: the token is still current.
        expect(await s.renewLease(lease, 100, 6000)).toBe(true);
        expect(await s.commit(lease, { release: true, status: "queued" }, [], 6010)).toBe(true);
        expect(await s.renewLease(lease, 100, 6020)).toBe(false);
      });
    });

    describe("commit", () => {
      test("commit merges journal keys, null deletes a key, null clears fields", async (s) => {
        await s.createRun(
          newRun("r1", {
            journal: { a: done(1), b: done(2) },
            currentStep: "b",
            wakeAt: 5,
            waitReason: "retry",
            callbackToken: "tok",
            callbackExpiresAt: 50,
            resume: { kind: "timer" },
            error: { message: "old" },
            status: "waiting",
          }),
          [],
          0,
        );
        const lease = await claimOrFail(s, 10);
        const ok = await s.commit(
          lease,
          {
            journal: { b: null, c: done(3) },
            attempt: 2,
            currentStep: "c",
            wakeAt: null,
            waitReason: null,
            callbackToken: null,
            callbackExpiresAt: null,
            resume: null,
            error: null,
            output: { result: true },
          },
          [],
          20,
        );
        expect(ok).toBe(true);
        const run = await s.getRun(T1, "r1");
        expect(run?.journal).toEqual({ a: done(1), c: done(3) });
        expect(run).toMatchObject({
          attempt: 2,
          currentStep: "c",
          output: { result: true },
          status: "running",
          leaseOwner: "w1",
          updatedAt: 20,
        });
        for (const key of [
          "wakeAt",
          "waitReason",
          "callbackToken",
          "callbackExpiresAt",
          "resume",
          "error",
        ] as const) {
          expect(run?.[key]).toBeUndefined();
        }
        // Lease kept without release: the same token may commit again.
        expect(await s.commit(lease, { currentStep: null }, [], 30)).toBe(true);
        expect((await s.getRun(T1, "r1"))?.currentStep).toBeUndefined();
      });

      test("commit with release clears the lease", async (s) => {
        await s.createRun(newRun("r1"), [], 0);
        const lease = await claimOrFail(s, 10);
        expect(
          await s.commit(
            lease,
            { status: "waiting", wakeAt: 500, waitReason: "timer", release: true },
            [],
            20,
          ),
        ).toBe(true);
        const run = await s.getRun(T1, "r1");
        expect(run?.leaseOwner).toBeUndefined();
        expect(run?.leaseUntil).toBeUndefined();
        expect(run?.status).toBe("waiting");
        expect(await s.commit(lease, { status: "completed" }, [], 30)).toBe(false);
        expect(await s.renewLease(lease, 100, 30)).toBe(false);
        expect(await s.claimRun({ workerId: "w", leaseMs: 1, now: 499 })).toBeNull();
        expect((await claimOrFail(s, 500)).run.id).toBe("r1");
      });

      test("commit with wakeParent resumes the parent atomically", async (s) => {
        await s.createRun(
          newRun("parent", {
            status: "waiting",
            currentStep: "call",
            waitReason: "subflow",
            wakeAt: 99_999,
          }),
          [],
          0,
        );
        await s.createRun(
          newRun("child", { parent: { runId: "parent", stepPath: "call" } }),
          [],
          1,
        );
        const lease = await claimOrFail(s, 10);
        expect(lease.run.id).toBe("child");
        const resume = { kind: "subflow" as const, output: { ok: 1 } };
        const ok = await s.commit(
          lease,
          {
            status: "completed",
            release: true,
            wakeParent: { runId: "parent", stepPath: "call", resume },
          },
          [ev("child", "run.completed"), ev("parent", "run.resumed")],
          20,
        );
        expect(ok).toBe(true);
        const parent = await s.getRun(T1, "parent");
        expect(parent).toMatchObject({ status: "queued", resume, updatedAt: 20 });
        expect(parent?.waitReason).toBe("subflow");
        expect(parent?.wakeAt).toBeUndefined();
        expect((await s.listEvents(T1, "parent")).map((e) => e.type)).toEqual(["run.resumed"]);
        expect((await claimOrFail(s, 30)).run.id).toBe("parent");
      });

      test("commit with wakeParent leaves a parent on another step untouched", async (s) => {
        await s.createRun(newRun("parent", { status: "waiting", currentStep: "other" }), [], 0);
        await s.createRun(newRun("child"), [], 1);
        const before = await s.getRun(T1, "parent");
        const lease = await claimOrFail(s, 10);
        const ok = await s.commit(
          lease,
          {
            status: "completed",
            release: true,
            wakeParent: { runId: "parent", stepPath: "call", resume: { kind: "timer" } },
          },
          [],
          20,
        );
        expect(ok).toBe(true);
        expect(await s.getRun(T1, "parent")).toEqual(before);
        expect((await s.getRun(T1, "child"))?.status).toBe("completed");
      });

      test("commit with a stale lease does not wake the parent", async (s) => {
        await s.createRun(newRun("parent", { status: "waiting", currentStep: "call" }), [], 0);
        await s.createRun(newRun("child"), [], 1);
        const stale = await claimOrFail(s, 10, "w1");
        await claimOrFail(s, 2000, "w2");
        const before = await s.getRun(T1, "parent");
        const ok = await s.commit(
          stale,
          {
            status: "completed",
            release: true,
            wakeParent: { runId: "parent", stepPath: "call", resume: { kind: "timer" } },
          },
          [ev("parent", "run.resumed")],
          2001,
        );
        expect(ok).toBe(false);
        expect(await s.getRun(T1, "parent")).toEqual(before);
        expect(await s.listEvents(T1, "parent")).toEqual([]);
      });

      test("commit with createChild inserts the child atomically and is idempotent", async (s) => {
        await s.createRun(newRun("parent"), [], 0);
        const lease = await claimOrFail(s, 10);
        const child = newRun("parent:call:1", {
          workflowId: "sub",
          parent: { runId: "parent", stepPath: "call" },
          startedBy: { kind: "subflow", parentRunId: "parent", parentStepPath: "call" },
        });
        const ok = await s.commit(
          lease,
          { status: "waiting", currentStep: "call", waitReason: "subflow", createChild: child },
          [ev("parent", "run.suspended"), ev(child.id, "run.started")],
          20,
        );
        expect(ok).toBe(true);
        const stored = await s.getRun(T1, child.id);
        expect(stored).toEqual({ ...child, createdAt: 20, updatedAt: 20 });
        expect((await s.listEvents(T1, child.id)).map((e) => [e.seq, e.type])).toEqual([
          [1, "run.started"],
        ]);

        // Same child id again: no duplicate, existing child untouched, commit still succeeds.
        const again = await s.commit(
          lease,
          { createChild: { ...child, trigger: "different" } },
          [],
          30,
        );
        expect(again).toBe(true);
        expect(await s.getRun(T1, child.id)).toEqual(stored);
        expect((await s.listRuns(T1, { workflowId: "sub" })).map((r) => r.id)).toEqual([child.id]);
      });
    });

    describe("resume", () => {
      test("resumeByToken is single use", async (s) => {
        await s.createRun(
          newRun("r1", {
            status: "waiting",
            currentStep: "wait",
            waitReason: "callback",
            callbackToken: "tok-1",
            callbackExpiresAt: 1000,
            wakeAt: 1000,
          }),
          [],
          0,
        );
        const resume = { kind: "callback" as const, body: { approved: true } };
        const run = await s.resumeByToken("tok-1", resume, 500);
        expect(run).toMatchObject({ id: "r1", status: "queued", resume, updatedAt: 500 });
        expect(run?.callbackToken).toBeUndefined();
        expect(run?.callbackExpiresAt).toBeUndefined();
        expect(run?.wakeAt).toBeUndefined();
        expect(run?.waitReason).toBe("callback");
        expect(await s.getRun(T1, "r1")).toEqual(run);
        expect(await s.resumeByToken("tok-1", resume, 501)).toBeNull();
        expect(await s.resumeByToken("unknown", resume, 501)).toBeNull();
      });

      test("resumeByToken rejects an expired token", async (s) => {
        await s.createRun(
          newRun("r1", {
            status: "waiting",
            waitReason: "callback",
            callbackToken: "tok-1",
            callbackExpiresAt: 1000,
          }),
          [],
          0,
        );
        const before = await s.getRun(T1, "r1");
        expect(await s.resumeByToken("tok-1", { kind: "callback", body: 1 }, 1000)).toBeNull();
        expect(await s.getRun(T1, "r1")).toEqual(before);
      });

      test("resumeByToken ignores runs that are not waiting", async (s) => {
        await s.createRun(newRun("r1", { callbackToken: "tok-1", callbackExpiresAt: 1000 }), [], 0);
        expect(await s.resumeByToken("tok-1", { kind: "callback", body: 1 }, 10)).toBeNull();
        expect((await s.getRun(T1, "r1"))?.status).toBe("queued");
      });

      test("resumeRun requires a waiting run on the expected step", async (s) => {
        await s.createRun(
          newRun("r1", { status: "waiting", currentStep: "call", waitReason: "subflow" }),
          [],
          0,
        );
        await s.createRun(newRun("r2", { currentStep: "call" }), [], 0);
        const resume = { kind: "subflowFailed" as const, error: { message: "x" } };
        expect(await s.resumeRun("r1", "wrong", resume, 10)).toBe(false);
        expect((await s.getRun(T1, "r1"))?.status).toBe("waiting");
        expect(await s.resumeRun("r2", "call", resume, 10)).toBe(false);
        expect(await s.resumeRun("missing", "call", resume, 10)).toBe(false);
        expect(await s.resumeRun("r1", "call", resume, 20)).toBe(true);
        expect(await s.getRun(T1, "r1")).toMatchObject({ status: "queued", resume, updatedAt: 20 });
        expect(await s.resumeRun("r1", "call", resume, 30)).toBe(false);
      });
    });

    describe("updateRunUnleased", () => {
      test("updates a run without a lease, with events", async (s) => {
        await s.createRun(
          newRun("r1", { status: "waiting", wakeAt: 100, journal: { a: done(1) } }),
          [ev("r1", "run.started")],
          0,
        );
        const ok = await s.updateRunUnleased(
          T1,
          "r1",
          { status: "cancelled", wakeAt: null, journal: { a: null } },
          [ev("r1", "run.cancelled")],
          50,
        );
        expect(ok).toBe(true);
        const run = await s.getRun(T1, "r1");
        expect(run).toMatchObject({ status: "cancelled", journal: {}, updatedAt: 50 });
        expect(run?.wakeAt).toBeUndefined();
        expect((await s.listEvents(T1, "r1")).map((e) => [e.seq, e.type])).toEqual([
          [1, "run.started"],
          [2, "run.cancelled"],
        ]);
        expect(await s.updateRunUnleased(T1, "missing", { status: "cancelled" }, [], 60)).toBe(
          false,
        );
      });

      test("refuses a run with an unexpired lease", async (s) => {
        await s.createRun(newRun("r1"), [], 0);
        const lease = await claimOrFail(s, 10); // until 1010
        const before = await s.getRun(T1, "r1");
        expect(
          await s.updateRunUnleased(
            T1,
            "r1",
            { status: "cancelled" },
            [ev("r1", "run.cancelled")],
            1010,
          ),
        ).toBe(false);
        expect(await s.getRun(T1, "r1")).toEqual(before);
        expect(await s.listEvents(T1, "r1")).toEqual([]);
        expect(await s.commit(lease, { status: "completed", release: true }, [], 1010)).toBe(true);
      });

      test("clears an expired lease so its token can no longer commit", async (s) => {
        await s.createRun(newRun("r1"), [], 0);
        const lease = await claimOrFail(s, 10); // until 1010
        expect(await s.updateRunUnleased(T1, "r1", { status: "cancelled" }, [], 1011)).toBe(true);
        const run = await s.getRun(T1, "r1");
        expect(run?.status).toBe("cancelled");
        expect(run?.leaseOwner).toBeUndefined();
        expect(run?.leaseUntil).toBeUndefined();
        expect(await s.commit(lease, { status: "completed" }, [], 1012)).toBe(false);
        expect((await s.getRun(T1, "r1"))?.status).toBe("cancelled");
      });

      test("supports wakeParent (cancelling a child)", async (s) => {
        await s.createRun(newRun("parent", { status: "waiting", currentStep: "call" }), [], 0);
        await s.createRun(newRun("child", { status: "waiting", wakeAt: 99 }), [], 0);
        const resume = { kind: "subflowFailed" as const, error: { message: "cancelled" } };
        expect(
          await s.updateRunUnleased(
            T1,
            "child",
            { status: "cancelled", wakeParent: { runId: "parent", stepPath: "call", resume } },
            [],
            10,
          ),
        ).toBe(true);
        expect(await s.getRun(T1, "parent")).toMatchObject({ status: "queued", resume });
      });
    });

    describe("events", () => {
      test("events get strictly increasing seq per run and listEvents orders by seq", async (s) => {
        await s.createRun(newRun("r1"), [ev("r1", "run.started", 1)], 0);
        await s.createRun(newRun("r2"), [ev("r2", "run.started", 1)], 0);
        const lease = await claimOrFail(s, 10);
        expect(lease.run.id).toBe("r1");
        await s.commit(
          lease,
          { journal: { a: done(1) } },
          [
            { ...ev("r1", "step.started", 11), stepPath: "a", workerId: "w1" },
            { ...ev("r1", "step.completed", 12), stepPath: "a", data: { output: 1 } },
          ],
          12,
        );
        await s.appendEvents([ev("r1", "step.started", 13), ev("r2", "step.started", 13)]);
        await s.appendEvents([]);
        await s.commit(
          lease,
          { status: "completed", release: true },
          [ev("r1", "run.completed", 14)],
          14,
        );

        const events = await s.listEvents(T1, "r1");
        expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
        expect(events.map((e) => e.type)).toEqual([
          "run.started",
          "step.started",
          "step.completed",
          "step.started",
          "run.completed",
        ]);
        expect(events[1]).toMatchObject({
          runId: "r1",
          tenantId: T1,
          type: "step.started",
          stepPath: "a",
          workerId: "w1",
          at: 11,
        });
        expect(events[2]?.data).toEqual({ output: 1 });
        const ids = new Set(events.map((e) => e.id));
        expect(ids.size).toBe(5);
        for (const id of ids) expect(typeof id).toBe("string");

        expect((await s.listEvents(T1, "r2")).map((e) => e.seq)).toEqual([1, 2]);
        expect(await s.listEvents(T1, "missing")).toEqual([]);
      });

      test("concurrent appends keep seq unique and gap-free", async (s) => {
        await s.createRun(newRun("r1"), [], 0);
        await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            s.appendEvents([ev("r1", "step.started", i), ev("r1", "step.completed", i)]),
          ),
        );
        const seqs = (await s.listEvents(T1, "r1")).map((e) => e.seq);
        expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      });
    });

    test("recordDedupeKey is true once, then false, then true again after the ttl", async (s) => {
      expect(await s.recordDedupeKey(T1, "schedule:wf:100", 1000, 500)).toBe(true);
      expect(await s.recordDedupeKey(T1, "schedule:wf:100", 1200, 500)).toBe(false);
      expect(await s.recordDedupeKey(T1, "schedule:wf:100", 1499, 500)).toBe(false);
      expect(await s.recordDedupeKey(T1, "other", 1200, 500)).toBe(true);
      expect(await s.recordDedupeKey(T1, "schedule:wf:100", 1500, 500)).toBe(true);
      expect(await s.recordDedupeKey(T1, "schedule:wf:100", 1600, 500)).toBe(false);
      const concurrent = await Promise.all(
        Array.from({ length: 10 }, () => s.recordDedupeKey(T1, "race", 0, 1000)),
      );
      expect(concurrent.filter(Boolean)).toHaveLength(1);
    });
  });
}
