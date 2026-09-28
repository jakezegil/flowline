import {
  createRegistry,
  defineNode,
  definePlugin,
  defineTrigger,
  type Step,
  suspend,
  type WorkflowDoc,
} from "@flowlinejs/core";
import { createMemoryStorage } from "@flowlinejs/storage-memory";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createEngine } from "./engine";
import type { StorageAdapter } from "./storage";

const TENANT = "t1";

let seenB: unknown[];

const registry = createRegistry([
  definePlugin({
    id: "t",
    name: "Test",
    triggers: [
      defineTrigger({ type: "t.manual", name: "Manual", kind: "manual", config: z.object({}) }),
    ],
    nodes: [
      defineNode({
        type: "t.echo",
        name: "Echo",
        input: z.object({ label: z.string() }),
        run: ({ input, ctx }) => {
          if (ctx.stepId === "b") seenB.push(input.label);
          return { label: input.label };
        },
      }),
      defineNode({
        type: "t.wait",
        name: "Wait for callback",
        input: z.object({}),
        run: async ({ ctx }) =>
          ctx.resume
            ? { resumed: true }
            : suspend({ callback: await ctx.callback({ timeoutMs: 1e6 }) }),
      }),
    ],
  }),
]);

let storage: StorageAdapter;
const now = 1_000_000;

const doc = (bLabel: string): WorkflowDoc => ({
  id: "wf",
  name: "Workflow",
  trigger: { type: "t.manual", config: {} },
  steps: [
    { id: "a", type: "t.echo", config: { label: "A" } },
    { id: "wait", type: "t.wait", config: {} },
    { id: "b", type: "t.echo", config: { label: bLabel } } satisfies Step,
  ],
});

async function publish(d: WorkflowDoc) {
  const v = await storage.saveWorkflowVersion(TENANT, d, "user", now);
  await storage.publishVersion(TENANT, d.id, v.version, now);
  return v.version;
}

/** Start a run of the currently published version, as a trigger would. */
async function startPublished(id: string) {
  const published = await storage.getPublishedVersion(TENANT, "wf");
  await storage.createRun(
    {
      id,
      tenantId: TENANT,
      workflowId: "wf",
      version: published!.version,
      status: "queued",
      trigger: {},
      journal: {},
      attempt: 1,
      startedBy: { kind: "manual" },
    },
    [],
    now,
  );
}

beforeEach(() => {
  storage = createMemoryStorage();
  seenB = [];
});

describe("version pinning", () => {
  it("keeps a waiting run on its pinned version after a new version is published", async () => {
    const engine = createEngine({ registry, storage, clock: () => now });
    expect(await publish(doc("B v1"))).toBe(1);
    await startPublished("old");
    await engine.drain();
    expect((await storage.getRun(TENANT, "old"))?.status).toBe("waiting");

    expect(await publish(doc("B v2"))).toBe(2);
    expect(await engine.resumeRun(TENANT, "old", {}, "u1")).toBe("resumed");
    await engine.drain();
    const old = await storage.getRun(TENANT, "old");
    expect(old).toMatchObject({ status: "completed", version: 1 });
    expect(old?.journal.b).toMatchObject({ output: { label: "B v1" } });

    await startPublished("new");
    await engine.drain();
    const token = (await storage.getRun(TENANT, "new"))?.callbackToken;
    expect(await engine.resume(token!, {})).toBe("resumed");
    await engine.drain();
    const fresh = await storage.getRun(TENANT, "new");
    expect(fresh).toMatchObject({ status: "completed", version: 2 });
    expect(seenB).toEqual(["B v1", "B v2"]);
  });
});
