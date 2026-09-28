import { createRegistry, defineNode, definePlugin, type WorkflowDoc } from "@flowkit/core";
import { createMemoryStorage } from "@flowkit/storage-memory";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createEngine, type Engine } from "./engine";
import type { StorageAdapter } from "./storage";

const echo = defineNode({
  type: "t.echo",
  name: "Echo",
  input: z.object({ value: z.unknown() }),
  run: ({ input }) => ({ value: input.value }),
});
const registry = createRegistry([definePlugin({ id: "t", name: "T", nodes: [echo] })]);

const at = (h: number, m: number) => Date.UTC(2026, 0, 1, h, m);

const scheduleDoc = (id: string, cron: string, timezone = "UTC"): WorkflowDoc => ({
  id,
  name: id,
  trigger: { type: "core.schedule", config: { cron, timezone } },
  steps: [{ id: "e", type: "t.echo", config: { value: { $ref: "trigger.firedAt" } } }],
});

let storage: StorageAdapter;
let now: number;
let engine: Engine;

const newEngine = () => createEngine({ registry, storage, clock: () => now });

async function deploy(doc: WorkflowDoc, tenant = "t1") {
  const v = await engine.saveWorkflow(tenant, doc, "u");
  await engine.publish(tenant, doc.id, v.version, "u");
}

beforeEach(() => {
  storage = createMemoryStorage();
  now = at(10, 2);
  engine = newEngine();
});

describe("tickSchedules", () => {
  it("fires each due time once, never before the publish time", async () => {
    await deploy(scheduleDoc("every5", "*/5 * * * *"));
    now = at(10, 4);
    expect(await engine.tickSchedules()).toBe(0);
    now = at(10, 5);
    expect(await engine.tickSchedules()).toBe(1);
    now = at(10, 6);
    expect(await engine.tickSchedules()).toBe(0);

    const runs = await storage.listRuns("t1", {});
    expect(runs).toHaveLength(1);
    const run = await storage.getRun("t1", runs[0]?.id as string);
    expect(run).toMatchObject({
      trigger: { firedAt: "2026-01-01T10:05:00.000Z" },
      startedBy: { kind: "schedule", fireAt: at(10, 5) },
    });
    await engine.drain();
    expect((await storage.getRun("t1", run?.id as string))?.status).toBe("completed");
  });

  it("starts exactly one run when two engines tick concurrently", async () => {
    await deploy(scheduleDoc("every5", "*/5 * * * *"));
    const other = newEngine();
    now = at(10, 10);
    const counts = await Promise.all([engine.tickSchedules(), other.tickSchedules()]);
    expect(counts[0] + counts[1]).toBe(1);
    expect(await storage.listRuns("t1", {})).toHaveLength(1);
  });

  it("runs only the latest missed fire after downtime", async () => {
    await deploy(scheduleDoc("every5", "*/5 * * * *"));
    now = at(11, 3);
    expect(await engine.tickSchedules()).toBe(1);
    const [run] = await storage.listRuns("t1", {});
    expect(run?.startedBy).toEqual({ kind: "schedule", fireAt: at(11, 0) });
  });

  it("evaluates cron expressions in the configured time zone", async () => {
    // 12:00 in Berlin (UTC+1 in January) is 11:00 UTC.
    await deploy(scheduleDoc("berlin", "0 12 * * *", "Europe/Berlin"));
    now = at(10, 59);
    expect(await engine.tickSchedules()).toBe(0);
    now = at(11, 0);
    expect(await engine.tickSchedules()).toBe(1);
  });

  it("fires per tenant and skips other trigger kinds and broken schedules", async () => {
    await deploy(scheduleDoc("a", "*/5 * * * *"), "t1");
    await deploy(scheduleDoc("a", "*/5 * * * *"), "t2");
    await deploy({
      id: "manual",
      name: "m",
      trigger: { type: "core.manual", config: {} },
      steps: [{ id: "e", type: "t.echo", config: { value: 1 } }],
    });
    // A doc whose cron cannot be parsed (saved straight to storage, bypassing validation).
    const broken = scheduleDoc("broken", "61 * * * *");
    const v = await storage.saveWorkflowVersion("t1", broken, "u", now);
    await storage.publishVersion("t1", "broken", v.version, now);

    now = at(10, 5);
    expect(await engine.tickSchedules()).toBe(2);
    expect(await storage.listRuns("t1", {})).toHaveLength(1);
    expect(await storage.listRuns("t2", {})).toHaveLength(1);
  });
});

describe("startWorker", () => {
  it("runs queued runs and ticks schedules until stopped", async () => {
    await deploy(scheduleDoc("every5", "*/5 * * * *"));
    now = at(10, 5);
    const worker = engine.startWorker({ concurrency: 2, pollMs: 5, scheduleEveryMs: 10 });
    try {
      await expect
        .poll(async () => (await storage.listRuns("t1", { status: "completed" })).length, {
          timeout: 3_000,
        })
        .toBe(1);
    } finally {
      await worker.stop();
    }
    const [run] = await storage.listRuns("t1", {});
    const events = await storage.listEvents("t1", run?.id as string);
    expect(events.find((e) => e.type === "step.started")?.workerId).toMatch(/.+/);
  });

  it("stop() waits for in-flight work", async () => {
    let finished = false;
    const slow = defineNode({
      type: "s.slow",
      name: "Slow",
      input: z.object({}),
      run: async () => {
        await new Promise((r) => setTimeout(r, 100));
        finished = true;
        return {};
      },
    });
    const e = createEngine({
      registry: createRegistry([definePlugin({ id: "s", name: "S", nodes: [slow] })]),
      storage,
      clock: () => now,
    });
    const v = await e.saveWorkflow(
      "t1",
      {
        id: "slow",
        name: "slow",
        trigger: { type: "core.manual", config: {} },
        steps: [{ id: "x", type: "s.slow", config: {} }],
      },
      "u",
    );
    await e.publish("t1", "slow", v.version, "u");
    await e.start({ tenantId: "t1", workflowId: "slow" });
    const worker = e.startWorker({ pollMs: 5 });
    await expect.poll(async () => (await storage.listRuns("t1", {}))[0]?.status).toBe("running");
    await worker.stop();
    expect(finished).toBe(true);
  });
});
