import {
  createRegistry,
  defineNode,
  definePlugin,
  defineTrigger,
  invokeSubflow,
  type NodeContext,
  type ResumeInfo,
  type Step,
  stop,
  suspend,
  type WorkflowDoc,
} from "@flowline/core";
import { createMemoryStorage } from "@flowline/storage-memory";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { sha256Hex } from "./context";
import { createEngine, type EngineOptions } from "./engine";
import { FatalError } from "./errors";
import type { StorageAdapter } from "./storage";

const TENANT = "t1";

let calls: Record<string, number>;
let behaviours: Record<string, (ctx: NodeContext) => unknown>;
let resumes: ResumeInfo[];

const fieldDecl = z.object({
  name: z.string(),
  type: z.string(),
  required: z.boolean().optional(),
});

const registry = createRegistry([
  definePlugin({
    id: "t",
    name: "Test",
    triggers: [
      defineTrigger({ type: "t.manual", name: "Manual", kind: "manual", config: z.object({}) }),
      defineTrigger({
        type: "t.subflow",
        name: "Sub-flow",
        kind: "subflow",
        config: z.object({ input: z.array(fieldDecl) }),
        dynamicPayload: { kind: "fields", configPath: "input" },
      }),
      defineTrigger({
        type: "t.typed",
        name: "Typed",
        kind: "subflow",
        config: z.object({}),
        payload: z.object({ n: z.number() }),
      }),
    ],
    nodes: [
      defineNode({
        type: "t.node",
        name: "Node",
        input: z.object({ value: z.unknown().optional() }),
        run: ({ input, ctx }) => {
          calls[ctx.stepPath] = (calls[ctx.stepPath] ?? 0) + 1;
          const b = behaviours[ctx.stepId];
          return (b ? b(ctx) : { value: input.value }) as never;
        },
      }),
      defineNode({
        type: "t.call",
        name: "Call sub-flow",
        input: z.object({ workflowId: z.string(), input: z.record(z.string(), z.unknown()) }),
        run: ({ input, ctx }) => {
          calls[`${ctx.runId}:${ctx.stepPath}`] = (calls[`${ctx.runId}:${ctx.stepPath}`] ?? 0) + 1;
          if (ctx.resume?.kind === "subflow") {
            resumes.push(ctx.resume);
            return ctx.resume.output;
          }
          if (ctx.resume?.kind === "subflowFailed") {
            resumes.push(ctx.resume);
            throw new FatalError(ctx.resume.error.message);
          }
          return invokeSubflow({ workflowId: input.workflowId, input: input.input });
        },
      }),
    ],
  }),
]);

let storage: StorageAdapter;
let now: number;
const clock = () => now;
let runSeq = 0;

const makeEngine = (extra: Partial<EngineOptions> = {}) =>
  createEngine({ registry, storage, clock, ...extra });

const node = (id: string, config: Step["config"] = {}): Step => ({ id, type: "t.node", config });
const call = (id: string, workflowId: string, input: Step["config"] = {}): Step => ({
  id,
  type: "t.call",
  config: { workflowId, input },
});

async function publish(doc: WorkflowDoc) {
  const v = await storage.saveWorkflowVersion(TENANT, doc, "user", now);
  await storage.publishVersion(TENANT, doc.id, v.version, now);
  return v;
}

async function startRun(doc: WorkflowDoc, trigger: unknown = {}): Promise<string> {
  const v = await publish(doc);
  const id = `run-${++runSeq}`;
  await storage.createRun(
    {
      id,
      tenantId: TENANT,
      workflowId: doc.id,
      version: v.version,
      status: "queued",
      trigger,
      journal: {},
      attempt: 1,
      startedBy: { kind: "manual" },
    },
    [{ runId: id, tenantId: TENANT, type: "run.started", at: now }],
    now,
  );
  return id;
}

async function getRun(id: string) {
  const run = await storage.getRun(TENANT, id);
  if (!run) throw new Error(`run ${id} missing`);
  return run;
}

const childRuns = (workflowId: string) => storage.listRuns(TENANT, { workflowId });

/** Parent: call `get-or-create` with the trigger's email, then echo the child's id. */
const parentDoc: WorkflowDoc = {
  id: "parent",
  name: "Parent",
  trigger: { type: "t.manual", config: {} },
  steps: [
    call("call", "get-or-create", { email: { $ref: "trigger.email" } }),
    node("after", { value: { $ref: "steps.call.id" } }),
  ],
};

/** Child: "creates" a contact and maps its output. */
const childDoc: WorkflowDoc = {
  id: "get-or-create",
  name: "Get or create contact",
  trigger: {
    type: "t.subflow",
    config: { input: [{ name: "email", type: "string", required: true }] },
  },
  steps: [node("make", { value: { $tpl: "contact-{{trigger.email}}" } })],
  output: { id: { $ref: "steps.make.value" }, email: { $ref: "trigger.email" } },
};

beforeEach(() => {
  storage = createMemoryStorage();
  now = 1_000_000;
  calls = {};
  behaviours = {};
  resumes = [];
});

describe("sub-flows", () => {
  it("runs the child and hands its mapped output to the parent step", async () => {
    await publish(childDoc);
    const parentId = await startRun(parentDoc, { email: "a@x.test" });
    await makeEngine().drain();

    const parent = await getRun(parentId);
    expect(parent.status).toBe("completed");
    const output = { id: "contact-a@x.test", email: "a@x.test" };
    expect(parent.journal.call).toMatchObject({ status: "done", output });
    expect(parent.journal.after).toMatchObject({ output: { value: "contact-a@x.test" } });

    const [summary] = await childRuns("get-or-create");
    const expectedId = `sub_${(await sha256Hex(`${parentId}:call:1`)).slice(0, 24)}`;
    expect(summary?.id).toBe(expectedId);
    const child = await getRun(expectedId);
    expect(child).toMatchObject({
      status: "completed",
      output,
      trigger: { email: "a@x.test" },
      parent: { runId: parentId, stepPath: "call" },
      startedBy: { kind: "subflow", parentRunId: parentId, parentStepPath: "call" },
    });

    const events = await storage.listEvents(TENANT, parentId);
    expect(events.find((e) => e.type === "run.suspended")?.data).toEqual({
      workflowId: "get-or-create",
      childRunId: expectedId,
    });
    expect(events.find((e) => e.type === "run.resumed")?.data).toEqual({ kind: "subflow" });
    expect((await storage.listEvents(TENANT, expectedId))[0]?.type).toBe("run.started");
  });

  it("leaves the parent waiting on the child with no wake time", async () => {
    await publish(childDoc);
    const parentId = await startRun(parentDoc, { email: "a@x.test" });
    const engine = makeEngine();
    await engine.runOnce();
    const parent = await getRun(parentId);
    expect(parent).toMatchObject({ status: "waiting", waitReason: "subflow", currentStep: "call" });
    expect(parent.wakeAt).toBeUndefined();
    const [child] = await childRuns("get-or-create");
    expect(parent.journal.call).toEqual(
      expect.objectContaining({ status: "suspended", pending: { childRunId: child?.id } }),
    );
  });

  it("resumes the parent with subflowFailed when the child fails", async () => {
    behaviours.make = () => {
      throw new FatalError("no such contact");
    };
    await publish(childDoc);
    const parentId = await startRun(parentDoc, { email: "a@x.test" });
    await makeEngine().drain();
    expect(resumes).toEqual([{ kind: "subflowFailed", error: { message: "no such contact" } }]);
    const parent = await getRun(parentId);
    expect(parent.status).toBe("failed");
    expect(parent.error?.message).toBe("no such contact");
  });

  it("fails fatally when the sub-flow is not published", async () => {
    await storage.saveWorkflowVersion(TENANT, childDoc, "user", now);
    const parentId = await startRun(parentDoc, { email: "a@x.test" });
    await makeEngine().drain();
    const parent = await getRun(parentId);
    expect(parent.status).toBe("failed");
    expect(parent.error).toMatchObject({ fatal: true, code: "subflow.unknown", stepPath: "call" });
    expect(await childRuns("get-or-create")).toEqual([]);
  });

  it("does not see another tenant's published sub-flow", async () => {
    const v = await storage.saveWorkflowVersion("t2", childDoc, "user", now);
    await storage.publishVersion("t2", childDoc.id, v.version, now);
    const parentId = await startRun(parentDoc, { email: "a@x.test" });
    await makeEngine().drain();
    expect((await getRun(parentId)).error?.code).toBe("subflow.unknown");
  });

  it("validates the input against the child trigger's declared fields", async () => {
    await publish(childDoc);
    const missing = await startRun(parentDoc, {});
    const wrongType = await startRun(parentDoc, { email: 42 });
    await makeEngine().drain();
    for (const id of [missing, wrongType]) {
      const run = await getRun(id);
      expect(run.status).toBe("failed");
      expect(run.error).toMatchObject({ fatal: true, code: "subflow.input" });
      expect(run.error?.message).toContain('"email"');
    }
    expect(await childRuns("get-or-create")).toEqual([]);
  });

  it("validates the input against a child trigger's payload schema", async () => {
    await publish({
      id: "typed",
      name: "Typed",
      trigger: { type: "t.typed", config: {} },
      steps: [node("x")],
    });
    const bad = await startRun({ ...parentDoc, steps: [call("call", "typed", { n: "one" })] });
    await makeEngine().drain();
    expect((await getRun(bad)).error).toMatchObject({ code: "subflow.input" });
  });

  it("maps a stopped child's output when it resolves", async () => {
    behaviours.make = () => ({ value: "early" });
    await publish({ ...childDoc, steps: [...childDoc.steps, node("halt")] });
    behaviours.halt = () => stop("done early");
    const parentId = await startRun(parentDoc, { email: "a@x.test" });
    await makeEngine().drain();
    expect(resumes).toEqual([{ kind: "subflow", output: { id: "early", email: "a@x.test" } }]);
    const parent = await getRun(parentId);
    expect(parent.status).toBe("completed");
    // The parent's call step is done (the child's Stop doesn't stop the parent), and only the
    // child reads as stopped; top-level listings leave the child out.
    expect(parent.journal.call?.status).toBe("done");
    const runs = await storage.listRuns(TENANT, {});
    expect(runs.find((r) => r.id === parentId)).not.toHaveProperty("stoppedAt");
    expect(runs.find((r) => r.id !== parentId)?.stoppedAt).toBe("halt");
    expect((await storage.listRuns(TENANT, { topLevel: true })).map((r) => r.id)).toEqual([
      parentId,
    ]);
  });

  it("resumes the parent with subflowFailed when a stopped child's output does not resolve", async () => {
    behaviours.make = () => stop("nothing to do");
    await publish(childDoc);
    const parentId = await startRun(parentDoc, { email: "a@x.test" });
    await makeEngine().drain();
    expect(resumes).toEqual([
      { kind: "subflowFailed", error: { message: "Sub-flow stopped: nothing to do" } },
    ]);
    expect((await getRun(parentId)).status).toBe("failed");
  });

  it("resumes the parent with subflowFailed when the child is cancelled", async () => {
    behaviours.make = (ctx) => (ctx.resume ? {} : suspend({ until: ctx.now() + 60_000 }));
    await publish(childDoc);
    const parentId = await startRun(parentDoc, { email: "a@x.test" });
    const engine = makeEngine();
    await engine.drain();
    const [child] = await childRuns("get-or-create");
    await engine.cancelRun(TENANT, child!.id);
    expect((await getRun(parentId)).status).toBe("queued");
    await engine.drain();
    expect(resumes).toEqual([{ kind: "subflowFailed", error: { message: "Sub-flow cancelled" } }]);
  });

  it("resumes the parent with subflowFailed when a child is cancelled while it executes", async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => {
      started = r;
    });
    behaviours.make = (ctx) =>
      new Promise((_, reject) => {
        started();
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await publish(childDoc);
    const parentId = await startRun(parentDoc, { email: "a@x.test" });
    // Real renewal ticks every 20 ms poll for the cancel request.
    const engine = makeEngine({ leaseMs: 40 });
    await engine.runOnce(); // parent: starts the child and suspends
    const [child] = await childRuns("get-or-create");
    const claim = engine.runOnce(); // child: its handler blocks
    await running;
    expect(await engine.cancelRun(TENANT, child!.id)).toBe("requested");
    await claim;
    expect((await getRun(child!.id)).status).toBe("cancelled");
    expect((await getRun(parentId)).status).toBe("queued");
    await engine.drain();
    expect(resumes).toEqual([{ kind: "subflowFailed", error: { message: "Sub-flow cancelled" } }]);
    expect((await getRun(parentId)).status).toBe("failed");
  });

  it("refuses to retry a failed child whose parent no longer waits on it", async () => {
    behaviours.make = () => {
      throw new FatalError("down");
    };
    await publish(childDoc);
    const parentId = await startRun(parentDoc, { email: "a@x.test" });
    const engine = makeEngine();
    await engine.drain();
    const [child] = await childRuns("get-or-create");
    expect(child?.status).toBe("failed");
    expect((await getRun(parentId)).status).toBe("failed");
    await expect(engine.retryRun(TENANT, child!.id)).rejects.toThrow(
      /parent run "run-\d+" no longer waits on it; retry the parent instead/,
    );
    expect((await getRun(child!.id)).status).toBe("failed");
  });

  it("fails the step when no child run id is free", async () => {
    await publish(childDoc);
    const parentId = await startRun(parentDoc, { email: "a@x.test" });
    const base = storage;
    let lookups = 0;
    storage = {
      ...base,
      async getRunById(id) {
        if (!id.startsWith("sub_")) return base.getRunById(id);
        lookups++;
        const parent = await base.getRunById(parentId);
        return { ...parent!, id, status: "completed" };
      },
    };
    await makeEngine().drain();
    const parent = await base.getRun(TENANT, parentId);
    expect(parent?.status).toBe("failed");
    expect(parent?.error).toMatchObject({ code: "subflow.id", fatal: true, stepPath: "call" });
    expect(lookups).toBe(1000);
  });

  it("does not cancel children when the parent is cancelled", async () => {
    behaviours.make = (ctx) => (ctx.resume ? {} : suspend({ until: ctx.now() + 60_000 }));
    await publish(childDoc);
    const parentId = await startRun(parentDoc, { email: "a@x.test" });
    const engine = makeEngine();
    await engine.drain();
    await engine.cancelRun(TENANT, parentId);
    now += 60_000;
    await engine.drain();
    const [child] = await childRuns("get-or-create");
    expect(child?.status).toBe("completed");
    expect((await getRun(parentId)).status).toBe("cancelled");
  });

  it("caps nesting at 8 levels", async () => {
    const rec: WorkflowDoc = {
      id: "rec",
      name: "Recursive",
      trigger: { type: "t.subflow", config: { input: [] } },
      steps: [call("again", "rec")],
    };
    const rootId = await startRun(rec);
    await makeEngine().drain();
    const root = await getRun(rootId);
    expect(root.status).toBe("failed");
    expect(root.error?.message).toBe("Sub-flow nesting too deep");
    // The root plus 8 nested levels.
    expect(await storage.listRuns(TENANT, { workflowId: "rec" })).toHaveLength(9);
  });

  it("starts a fresh child when a failed sub-flow step is retried", async () => {
    let fail = true;
    behaviours.make = () => {
      if (fail) throw new FatalError("down");
      return { value: "ok" };
    };
    await publish(childDoc);
    const parentId = await startRun(parentDoc, { email: "a@x.test" });
    const engine = makeEngine();
    await engine.drain();
    expect((await getRun(parentId)).status).toBe("failed");
    fail = false;
    await engine.retryRun(TENANT, parentId);
    await engine.drain();
    const parent = await getRun(parentId);
    expect(parent.status).toBe("completed");
    expect(parent.journal.call).toMatchObject({ output: { id: "ok" } });
    const children = await childRuns("get-or-create");
    expect(children.map((c) => c.status).sort()).toEqual(["completed", "failed"]);
  });
});

describe("sub-flow crash safety", () => {
  it("creates no child when the worker dies before the suspend commit", async () => {
    await publish(childDoc);
    const parentId = await startRun(parentDoc, { email: "a@x.test" });
    let armed = true;
    const engine = makeEngine({
      leaseMs: 100,
      __testHooks: {
        beforeCommit(runId, stepPath, phase) {
          if (armed && runId === parentId && stepPath === "call" && phase === "result") {
            armed = false;
            throw new Error("crash");
          }
        },
      },
    });
    await expect(engine.runOnce()).rejects.toThrow("crash");
    expect(await childRuns("get-or-create")).toEqual([]);
    now += 200;
    await engine.drain();
    expect(await childRuns("get-or-create")).toHaveLength(1);
    expect((await getRun(parentId)).status).toBe("completed");
  });

  it("creates the child exactly once when the worker dies right after the suspend commit", async () => {
    await publish(childDoc);
    const parentId = await startRun(parentDoc, { email: "a@x.test" });
    let armed = true;
    const crashy: StorageAdapter = {
      ...storage,
      async commit(lease, patch, events, at) {
        const ok = await storage.commit(lease, patch, events, at);
        if (armed && patch.createChild) {
          armed = false;
          throw new Error("crash after commit");
        }
        return ok;
      },
    };
    let childCommitHeld = true;
    const engine = createEngine({
      registry,
      storage: crashy,
      clock,
      leaseMs: 100,
      __testHooks: {
        beforeCommit(runId, stepPath) {
          // The child's final commit crashes once: the parent must not be woken without it.
          if (runId.startsWith("sub_") && stepPath === "" && childCommitHeld) {
            childCommitHeld = false;
            throw new Error("child crash");
          }
        },
      },
    });
    await expect(engine.runOnce()).rejects.toThrow("crash after commit");
    const children = await childRuns("get-or-create");
    expect(children).toHaveLength(1);
    expect((await getRun(parentId)).status).toBe("waiting");

    await expect(engine.runOnce()).rejects.toThrow("child crash");
    expect((await getRun(parentId)).status).toBe("waiting");
    now += 200;
    await engine.runOnce(); // the child completes and wakes the parent in the same commit
    expect((await getRun(children[0]!.id)).status).toBe("completed");
    const parent = await getRun(parentId);
    expect(parent.status).toBe("queued");
    expect(parent.resume).toMatchObject({ kind: "subflow" });

    await engine.drain();
    expect((await getRun(parentId)).status).toBe("completed");
    expect(await childRuns("get-or-create")).toHaveLength(1);
    expect(calls[`${parentId}:call`]).toBe(2);
  });
});
