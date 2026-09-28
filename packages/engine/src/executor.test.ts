import {
  branch,
  createRegistry,
  defineNode,
  definePlugin,
  defineTrigger,
  type NodeContext,
  type RunEvent,
  type Step,
  secret,
  sensitive,
  stop,
  type WorkflowDoc,
} from "@flowkit/core";
import { createMemoryStorage } from "@flowkit/storage-memory";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createEngine, type EngineOptions } from "./engine";
import { FatalError, RetryableError } from "./errors";
import { createExecutor } from "./executor";
import { type StorageAdapter, stoppedAtOf } from "./storage";

const TENANT = "t1";

/** Handler hooks the tests swap per case. */
let calls: Record<string, number>;
let behaviours: Record<string, (ctx: NodeContext, input: unknown) => unknown>;

function count(key: string): number {
  calls[key] = (calls[key] ?? 0) + 1;
  return calls[key];
}

const registry = createRegistry([
  definePlugin({
    id: "test",
    name: "Test",
    triggers: [
      defineTrigger({ type: "test.manual", name: "Manual", kind: "manual", config: z.object({}) }),
    ],
    nodes: [
      defineNode({
        type: "test.echo",
        name: "Echo",
        input: z.object({ value: z.unknown().optional(), tag: z.string().optional() }),
        run: ({ input, ctx }) => {
          count(ctx.stepPath);
          const b = behaviours[ctx.stepId];
          if (b) return b(ctx, input) as never;
          return { value: input.value, tag: input.tag };
        },
      }),
      defineNode({
        type: "test.ifElse",
        name: "If/else",
        input: z.object({ cond: z.boolean() }),
        output: z.object({ matched: z.boolean() }),
        branches: {
          kind: "static",
          branches: [
            { id: "if", label: "If" },
            { id: "else", label: "Else" },
          ],
        },
        run: ({ input, ctx }) => {
          const b = behaviours[ctx.stepId];
          if (b) return b(ctx, input) as never;
          return branch(input.cond ? "if" : "else", { matched: input.cond });
        },
      }),
      defineNode({
        type: "test.switch",
        name: "Switch",
        input: z.object({
          value: z.unknown(),
          cases: z.array(z.object({ id: z.string(), label: z.string(), value: z.unknown() })),
        }),
        branches: {
          kind: "fromConfig",
          configPath: "cases",
          idKey: "id",
          labelKey: "label",
          append: [{ id: "default", label: "Default" }],
        },
        run: ({ input }) => {
          const hit = input.cases.find((c) => c.value === input.value);
          return branch(hit ? hit.id : "default", { matched: hit?.id ?? "default" });
        },
      }),
      defineNode({
        type: "test.forEach",
        name: "For each",
        input: z.object({ items: z.array(z.unknown()) }),
        branches: { kind: "loop", itemsField: "items", branch: "body" },
        run: ({ input, ctx }) => {
          const b = behaviours[ctx.stepId];
          if (b) return b(ctx, input) as never;
          return { items: input.items };
        },
      }),
      defineNode({
        type: "test.numeric",
        name: "Numeric",
        input: z.object({ n: z.number() }),
        run: ({ input }) => ({ n: input.n }),
      }),
      defineNode({
        type: "test.stop",
        name: "Stop",
        input: z.object({ reason: z.string().optional() }),
        run: ({ input }) => stop(input.reason),
      }),
      defineNode({
        type: "test.email",
        name: "Email",
        input: z.object({ to: z.string(), subject: z.string().optional() }),
        output: z.object({ sent: z.boolean() }),
        run: ({ ctx }) => {
          count(ctx.stepPath);
          return { sent: true };
        },
      }),
      defineNode({
        type: "test.secretive",
        name: "Secretive",
        input: z.object({
          apiKey: sensitive(z.string()),
          vault: secret().optional(),
          name: z.string(),
        }),
        output: z.object({ token: sensitive(z.string()), ok: z.boolean() }),
        run: () => ({ token: "tok-123", ok: true }),
      }),
      defineNode({
        type: "test.slowRetry",
        name: "Slow with retries",
        input: z.object({}),
        timeoutMs: 20,
        retry: { max: 3, backoff: undefined },
        run: ({ ctx }) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener("abort", () => resolve({ aborted: true }));
          }),
      }),
      defineNode({
        type: "test.slow",
        name: "Slow",
        input: z.object({}),
        timeoutMs: 20,
        retry: { max: 1 },
        run: ({ ctx }) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener("abort", () => resolve({ aborted: true }));
          }),
      }),
      defineNode({
        type: "test.badOutput",
        name: "Bad output",
        input: z.object({}),
        output: z.object({ n: z.number() }),
        run: () => ({ n: "nope" }) as never,
      }),
    ],
  }),
]);

class FakeClock {
  t = 1_000_000;
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

let storage: StorageAdapter;
let clock: FakeClock;
let runSeq = 0;

function makeEngine(extra: Partial<EngineOptions> = {}) {
  return createEngine({ registry, storage, clock: clock.now, ...extra });
}

const step = (id: string, type: string, config: Step["config"] = {}, extra: Partial<Step> = {}) =>
  ({ id, type, config, ...extra }) satisfies Step;

function wf(steps: Step[], extra: Partial<WorkflowDoc> = {}): WorkflowDoc {
  return {
    id: "wf",
    name: "Workflow",
    trigger: { type: "test.manual", config: {} },
    steps,
    ...extra,
  };
}

/** Save + publish `doc` and create a queued run for it directly in storage. */
async function startRun(doc: WorkflowDoc, trigger: unknown = {}): Promise<string> {
  const v = await storage.saveWorkflowVersion(TENANT, doc, "user", clock.now());
  await storage.publishVersion(TENANT, doc.id, v.version, clock.now());
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
    [{ runId: id, tenantId: TENANT, type: "run.started", at: clock.now() }],
    clock.now(),
  );
  return id;
}

async function getRun(id: string) {
  const run = await storage.getRun(TENANT, id);
  if (!run) throw new Error("run missing");
  return run;
}

async function events(id: string): Promise<RunEvent[]> {
  return storage.listEvents(TENANT, id);
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  storage = createMemoryStorage();
  clock = new FakeClock();
  calls = {};
  behaviours = {};
});

describe("executor: sync steps", () => {
  it("runs three linear steps to completion with the exact event sequence", async () => {
    const engine = makeEngine();
    const id = await startRun(
      wf([
        step("a", "test.echo", { value: { $ref: "trigger.x" } }),
        step("b", "test.echo", { value: { $ref: "steps.a.value" } }),
        step("c", "test.echo", { tag: { $tpl: "got {{steps.b.value}}" } }),
      ]),
      { x: 42 },
    );
    expect(await engine.drain()).toBe(1);
    const run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(Object.values(run.journal).map((e) => e.status)).toEqual(["done", "done", "done"]);
    expect(run.journal.c).toMatchObject({ output: { tag: "got 42" }, attempts: 1 });
    expect((await events(id)).map((e) => e.type)).toEqual([
      "run.started",
      "step.started",
      "step.completed",
      "step.started",
      "step.completed",
      "step.started",
      "step.completed",
      "run.completed",
    ]);
    expect(run.leaseOwner).toBeUndefined();
  });

  it("returns false from runOnce when nothing is runnable", async () => {
    expect(await makeEngine().runOnce()).toBe(false);
  });

  it("evaluates the output mapping at the end of the run", async () => {
    const id = await startRun(
      wf([step("a", "test.echo", { value: "hi" })], {
        output: { greeting: { $ref: "steps.a.value" }, run: { $ref: "run.id" } },
      }),
    );
    await makeEngine().drain();
    const run = await getRun(id);
    expect(run.output).toEqual({ greeting: "hi", run: id });
  });

  it("wakes a waiting parent in the completing commit", async () => {
    const parentId = await startRun(wf([step("call", "test.echo")]));
    // Put the parent into the state a sub-flow call leaves it in (Task 8 creates it for real).
    const lease = (await storage.claimRun({ workerId: "setup", leaseMs: 1000, now: clock.now() }))!;
    await storage.commit(
      lease,
      {
        status: "waiting",
        waitReason: "subflow",
        currentStep: "call",
        journal: {
          call: {
            status: "suspended",
            pending: { childRunId: "child-1" },
            at: 1,
            startedAt: 1,
            attempts: 1,
          },
        },
      },
      [],
      clock.now(),
    );
    const v = await storage.getPublishedVersion(TENANT, "wf");
    await storage.createRun(
      {
        id: "child-1",
        tenantId: TENANT,
        workflowId: "wf",
        version: v!.version,
        status: "queued",
        trigger: {},
        journal: {},
        attempt: 1,
        startedBy: { kind: "subflow", parentRunId: parentId, parentStepPath: "call" },
        parent: { runId: parentId, stepPath: "call" },
      },
      [],
      clock.now(),
    );
    const engine = makeEngine();
    await engine.runOnce();
    const parent = await getRun(parentId);
    expect(parent.status).toBe("queued");
    expect(parent.resume).toEqual({ kind: "subflow", output: undefined });
  });

  it("gives handlers a context with a stable idempotency key and a frozen scope", async () => {
    const seen: NodeContext[] = [];
    behaviours.a = (ctx) => {
      seen.push(ctx);
      return { ok: true };
    };
    const id = await startRun(wf([step("a", "test.echo")]), { deep: { v: 1 } });
    await makeEngine().drain();
    const ctx = seen[0]!;
    expect(ctx.runId).toBe(id);
    expect(ctx.tenantId).toBe(TENANT);
    expect(ctx.workflowId).toBe("wf");
    expect(ctx.stepId).toBe("a");
    expect(ctx.stepPath).toBe("a");
    expect(ctx.attempt).toBe(1);
    expect(ctx.now()).toBe(clock.t);
    const expected = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${id}:a`));
    expect(ctx.idempotencyKey).toBe(Buffer.from(expected).toString("hex"));
    expect(Object.isFrozen(ctx.scope)).toBe(true);
    expect(Object.isFrozen((ctx.scope.trigger as { deep: object }).deep)).toBe(true);
  });

  it("serves secrets through ctx.secrets and fails fatally on unknown ones", async () => {
    behaviours.a = async (ctx) => ({ v: await ctx.secrets.get("known") });
    behaviours.b = async (ctx) => ({ v: await ctx.secrets.get("unknown") });
    const engine = makeEngine({
      secrets: { get: async (tenantId, name) => (name === "known" ? `${tenantId}-s` : undefined) },
    });
    const id = await startRun(wf([step("a", "test.echo"), step("b", "test.echo")]));
    await engine.drain();
    const run = await getRun(id);
    // The secret value is part of the handler's output only because the test node returns it.
    expect(run.journal.a).toMatchObject({ output: { v: "t1-s" } });
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({ fatal: true, stepPath: "b" });
    expect(run.error?.message).toContain('"unknown"');
  });

  it("requeues after stepsPerClaim actions", async () => {
    const engine = makeEngine({ stepsPerClaim: 2 });
    const id = await startRun(
      wf([step("a", "test.echo"), step("b", "test.echo"), step("c", "test.echo")]),
    );
    expect(await engine.runOnce()).toBe(true);
    const mid = await getRun(id);
    expect(mid.status).toBe("queued");
    expect(Object.keys(mid.journal)).toEqual(["a", "b"]);
    expect(mid.leaseOwner).toBeUndefined();
    await engine.drain();
    expect((await getRun(id)).status).toBe("completed");
  });
});

describe("executor: branches and loops", () => {
  it("runs only the taken branch, then the steps after the block", async () => {
    const id = await startRun(
      wf([
        step(
          "cond",
          "test.ifElse",
          { cond: { $ref: "trigger.go" } },
          {
            branches: {
              if: [step("yes", "test.echo", { value: { $ref: "steps.cond.matched" } })],
              else: [step("no", "test.echo")],
            },
          },
        ),
        step("after", "test.echo"),
      ]),
      { go: true },
    );
    await makeEngine().drain();
    const run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(run.journal.cond).toMatchObject({
      status: "done",
      branch: "if",
      output: { matched: true },
    });
    expect(run.journal["cond/if/yes"]).toMatchObject({ status: "done", output: { value: true } });
    expect(run.journal.after).toMatchObject({ status: "done" });
    expect(Object.keys(run.journal).some((k) => k.includes("no"))).toBe(false);
  });

  it("journals the branch even when the taken branch is empty", async () => {
    const id = await startRun(
      wf([
        step(
          "cond",
          "test.ifElse",
          { cond: false },
          { branches: { if: [step("yes", "test.echo")] } },
        ),
        step("after", "test.echo"),
      ]),
    );
    await makeEngine().drain();
    const run = await getRun(id);
    expect(run.journal.cond).toMatchObject({ status: "done", branch: "else" });
    expect(run.journal.after).toMatchObject({ status: "done" });
  });

  it("takes the default branch when no switch case matches", async () => {
    const id = await startRun(
      wf([
        step(
          "sw",
          "test.switch",
          {
            value: "zzz",
            cases: [
              { id: "a", label: "A", value: "a" },
              { id: "b", label: "B", value: "b" },
            ],
          },
          {
            branches: {
              a: [step("inA", "test.echo")],
              b: [step("inB", "test.echo")],
              default: [step("inDefault", "test.echo")],
            },
          },
        ),
      ]),
    );
    await makeEngine().drain();
    const run = await getRun(id);
    expect(run.journal.sw).toMatchObject({ status: "done", branch: "default" });
    expect(run.journal["sw/default/inDefault"]).toMatchObject({ status: "done" });
    expect(Object.keys(run.journal)).toEqual(["sw", "sw/default/inDefault"]);
  });

  it("fails fatally when a branch node returns plain output or an unknown branch", async () => {
    behaviours.c1 = () => ({ matched: true });
    behaviours.c2 = () => branch("sideways", { matched: true });
    const plain = await startRun(wf([step("c1", "test.ifElse", { cond: true })]));
    await makeEngine().drain();
    expect((await getRun(plain)).error).toMatchObject({ fatal: true, stepPath: "c1" });
    expect((await getRun(plain)).error?.message).toContain("must return branch()");

    const unknown = await startRun(wf([step("c2", "test.ifElse", { cond: true })], { id: "wf2" }));
    await makeEngine().drain();
    expect((await getRun(unknown)).error?.message).toContain('"sideways"');
  });

  it("runs a forEach body once per item with loop.item and loop.index in scope", async () => {
    const id = await startRun(
      wf([
        step(
          "each",
          "test.forEach",
          { items: { $ref: "trigger.list" } },
          {
            branches: {
              body: [
                step("x", "test.echo", {
                  value: { $ref: "loop.item" },
                  tag: { $tpl: "#{{loop.index}}" },
                }),
              ],
            },
          },
        ),
        step("after", "test.echo", { value: { $ref: "steps.each.count" } }),
      ]),
      { list: ["a", "b", "c"] },
    );
    await makeEngine().drain();
    const run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(run.journal["each/body[0]/x"]).toMatchObject({ output: { value: "a", tag: "#0" } });
    expect(run.journal["each/body[1]/x"]).toMatchObject({ output: { value: "b", tag: "#1" } });
    expect(run.journal["each/body[2]/x"]).toMatchObject({ output: { value: "c", tag: "#2" } });
    expect(run.journal.each).toMatchObject({
      status: "done",
      output: {
        count: 3,
        results: [
          { value: "a", tag: "#0" },
          { value: "b", tag: "#1" },
          { value: "c", tag: "#2" },
        ],
      },
    });
    expect(run.journal.after).toMatchObject({ output: { value: 3 } });
  });

  it("skips the body of a forEach over an empty array", async () => {
    const id = await startRun(
      wf([
        step(
          "each",
          "test.forEach",
          { items: [] },
          { branches: { body: [step("x", "test.echo")] } },
        ),
      ]),
    );
    await makeEngine().drain();
    const run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(run.journal.each).toMatchObject({ status: "done", output: { count: 0, results: [] } });
    expect(calls).toEqual({});
  });

  it("records null results for iterations whose body steps were all skipped", async () => {
    const id = await startRun(
      wf([
        step(
          "each",
          "test.forEach",
          { items: [1] },
          { branches: { body: [step("x", "test.echo", {}, { disabled: true })] } },
        ),
      ]),
    );
    await makeEngine().drain();
    expect((await getRun(id)).journal.each).toMatchObject({
      output: { count: 1, results: [null] },
    });
  });

  it("stops the run from inside a branch", async () => {
    const id = await startRun(
      wf([
        step(
          "cond",
          "test.ifElse",
          { cond: true },
          { branches: { if: [step("halt", "test.stop", { reason: "enough" })] } },
        ),
        step("after", "test.echo"),
      ]),
    );
    await makeEngine().drain();
    const run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ stoppedAt: "cond/if/halt", reason: "enough" });
    expect(run.journal["cond/if/halt"]).toMatchObject({
      status: "done",
      output: { stopped: true, reason: "enough" },
    });
    expect(run.journal.after).toBeUndefined();
    expect(calls.after).toBeUndefined();
    // The enclosing block keeps its `branched` entry (it never finished); summaries say stopped.
    expect(run.journal.cond?.status).toBe("branched");
    expect(stoppedAtOf(run)).toBe("cond/if/halt");
    const types = (await events(id)).map((e) => e.type);
    expect(types).toContain("run.stopped");
    expect(types).not.toContain("run.completed");
  });

  it("stops the run from inside a forEach body", async () => {
    const id = await startRun(
      wf([
        step(
          "each",
          "test.forEach",
          { items: { $ref: "trigger.list" } },
          { branches: { body: [step("halt", "test.stop", { reason: "first item" })] } },
        ),
        step("after", "test.echo"),
      ]),
      { list: ["a", "b", "c"] },
    );
    await makeEngine().drain();
    const run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(stoppedAtOf(run)).toBe("each/body[0]/halt");
    expect(run.journal.each?.status).toBe("looping");
    expect(run.journal["each/body[1]/halt"]).toBeUndefined();
    expect(run.journal.after).toBeUndefined();
    // The run detail says where it stopped, like the run summaries.
    const detail = await makeEngine().getRunDetail(TENANT, id);
    expect(detail?.run.stoppedAt).toBe("each/body[0]/halt");
  });

  it("skips disabled steps and continues", async () => {
    const id = await startRun(
      wf([step("a", "test.echo", {}, { disabled: true }), step("b", "test.echo")]),
    );
    await makeEngine().drain();
    const run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(run.journal.a).toEqual({ status: "skipped", at: clock.t });
    expect(run.journal.b).toMatchObject({ status: "done" });
    expect(calls.a).toBeUndefined();
    expect((await events(id)).map((e) => e.type)).toContain("step.skipped");
  });
});

describe("executor: errors and retries", () => {
  it("retries with exponential backoff and records attempts", async () => {
    behaviours.a = (ctx) => {
      if (ctx.attempt < 3) throw new Error(`boom ${ctx.attempt}`);
      return { ok: ctx.attempt };
    };
    const engine = makeEngine();
    const id = await startRun(wf([step("a", "test.echo")]));
    const t0 = clock.t;
    await engine.drain();
    let run = await getRun(id);
    expect(run).toMatchObject({
      status: "waiting",
      waitReason: "retry",
      wakeAt: t0 + 1000,
      attempt: 2,
      currentStep: "a",
    });
    expect(run.journal.a).toBeUndefined();

    clock.advance(999);
    expect(await engine.drain()).toBe(0);
    clock.advance(1);
    await engine.drain();
    run = await getRun(id);
    expect(run).toMatchObject({ status: "waiting", wakeAt: clock.t + 2000, attempt: 3 });

    clock.advance(2000);
    await engine.drain();
    run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(run.wakeAt).toBeUndefined();
    expect(run.waitReason).toBeUndefined();
    expect(run.attempt).toBe(1);
    expect(run.journal.a).toMatchObject({ status: "done", attempts: 3, output: { ok: 3 } });
    const retrying = (await events(id)).filter((e) => e.type === "step.retrying");
    expect(retrying.map((e) => e.data)).toEqual([
      { attempt: 1, delayMs: 1000, error: "boom 1" },
      { attempt: 2, delayMs: 2000, error: "boom 2" },
    ]);
  });

  it("fails after retries are exhausted", async () => {
    behaviours.a = () => {
      throw new RetryableError("flaky");
    };
    const engine = makeEngine();
    const id = await startRun(wf([step("a", "test.echo")]));
    for (let i = 0; i < 3; i++) {
      await engine.drain();
      clock.advance(10_000);
    }
    const run = await getRun(id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({ message: "flaky", stepPath: "a" });
    expect(run.journal.a).toMatchObject({ status: "failed", attempts: 3 });
    expect(calls.a).toBe(3);
  });

  it("fails immediately on FatalError without retrying", async () => {
    behaviours.a = () => {
      throw new FatalError("no way", { code: "E_NOPE" });
    };
    const id = await startRun(wf([step("a", "test.echo"), step("b", "test.echo")]));
    await makeEngine().drain();
    const run = await getRun(id);
    expect(run.status).toBe("failed");
    expect(run.error).toEqual({ message: "no way", code: "E_NOPE", stepPath: "a", fatal: true });
    expect(run.journal.a).toMatchObject({ status: "failed", attempts: 1 });
    expect(calls).toEqual({ a: 1 });
    const types = (await events(id)).map((e) => e.type);
    expect(types.slice(-2)).toEqual(["step.failed", "run.failed"]);
    expect(types).not.toContain("step.retrying");
  });

  it("fails fatally naming the field and ref when a required input resolves to undefined", async () => {
    const id = await startRun(
      wf([
        step("load", "test.echo", { value: { name: "Ann" } }),
        step("mail", "test.email", { to: { $ref: "steps.load.email" } }),
      ]),
    );
    await makeEngine().drain();
    const run = await getRun(id);
    expect(run.status).toBe("failed");
    expect(run.error?.fatal).toBe(true);
    expect(run.error?.message).toContain('Step "mail"');
    expect(run.error?.message).toContain('field "to"');
    expect(run.error?.message).toContain("steps.load.email");
    expect(run.journal.mail).toMatchObject({ status: "failed", attempts: 1 });
    expect(calls.mail).toBeUndefined();
  });

  it("uses the step name and says 'literal' for literal values", async () => {
    const id = await startRun(wf([step("mail", "test.email", { to: 5 }, { name: "Send it" })]));
    await makeEngine().drain();
    const message = (await getRun(id)).error?.message;
    expect(message).toContain('Step "Send it": field "to"');
    expect(message).toContain("(from literal)");
  });

  it("renders a template with a missing value as an empty string", async () => {
    const id = await startRun(
      wf([step("mail", "test.email", { to: { $tpl: "{{trigger.missing}}" } })]),
    );
    await makeEngine().drain();
    const run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(run.journal.mail).toMatchObject({ status: "done", input: { to: "" } });
  });

  it("fails fatally when the output does not match the declared schema", async () => {
    const id = await startRun(wf([step("bad", "test.badOutput")]));
    await makeEngine().drain();
    const run = await getRun(id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({ fatal: true, stepPath: "bad" });
  });

  it("aborts the handler signal at its timeout and retries as 'timed out'", async () => {
    const id = await startRun(wf([step("slow", "test.slow")]));
    await makeEngine().drain();
    const run = await getRun(id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({ message: "timed out", stepPath: "slow" });
    expect(run.error?.fatal).toBeFalsy();
  });

  it("fails the run when its node type is not registered", async () => {
    const id = await startRun(wf([step("x", "test.gone")]));
    await makeEngine().drain();
    const run = await getRun(id);
    expect(run.status).toBe("failed");
    expect(run.error?.message).toContain("test.gone");
  });
});

describe("executor: redaction", () => {
  it("masks secret fields in the journal and secret + sensitive fields in events, then applies redact", async () => {
    const id = await startRun(
      wf([step("s", "test.secretive", { apiKey: "hunter2", vault: "prod-key", name: "visible" })]),
    );
    await makeEngine({
      redact: (e) => (e.type === "step.completed" ? { ...e, data: { scrubbed: true } } : e),
    }).drain();
    const run = await getRun(id);
    // Journal: only `secret` fields are masked; `sensitive` values stay usable downstream.
    expect(run.journal.s).toMatchObject({
      input: { apiKey: "hunter2", vault: "[redacted]", name: "visible" },
      output: { token: "tok-123", ok: true },
    });
    const evs = await events(id);
    expect(evs.find((e) => e.type === "step.started")?.data).toEqual({
      input: { apiKey: "[redacted]", vault: "[redacted]", name: "visible" },
    });
    expect(evs.find((e) => e.type === "step.completed")?.data).toEqual({ scrubbed: true });
    expect(JSON.stringify(evs)).not.toContain("hunter2");
    expect(JSON.stringify(evs)).not.toContain("tok-123");
    expect(JSON.stringify({ run, evs })).not.toContain("prod-key");
  });

  it("lets a later step reference a sensitive output while its event stays masked", async () => {
    const id = await startRun(
      wf([
        step("s", "test.secretive", { apiKey: "k", name: "n" }),
        step("use", "test.echo", { value: { $ref: "steps.s.token" } }),
      ]),
    );
    await makeEngine().drain();
    const run = await getRun(id);
    expect(run.journal.use).toMatchObject({ status: "done", output: { value: "tok-123" } });
    const completed = (await events(id)).find(
      (e) => e.type === "step.completed" && e.stepPath === "s",
    );
    expect(completed?.data).toMatchObject({ output: { token: "[redacted]", ok: true } });
  });

  it("masks sensitive body outputs in a loop's step.completed event", async () => {
    const id = await startRun(
      wf([
        step(
          "each",
          "test.forEach",
          { items: [1] },
          { branches: { body: [step("s", "test.secretive", { apiKey: "k", name: "n" })] } },
        ),
      ]),
    );
    await makeEngine().drain();
    const run = await getRun(id);
    expect(run.journal.each).toMatchObject({
      output: { count: 1, results: [{ token: "tok-123", ok: true }] },
    });
    const completed = (await events(id)).find(
      (e) => e.type === "step.completed" && e.stepPath === "each",
    );
    expect(completed?.data).toMatchObject({
      output: { count: 1, results: [{ token: "[redacted]", ok: true }] },
    });
  });

  it("reports every persisted event to onEvent", async () => {
    const seen: string[] = [];
    const id = await startRun(wf([step("a", "test.echo")]));
    await makeEngine({ onEvent: (e) => seen.push(e.type) }).drain();
    expect(seen).toEqual(["step.started", "step.completed", "run.completed"]);
    expect((await events(id)).length).toBe(4);
  });
});

describe("executor: durability", () => {
  it("re-runs only the interrupted step after a crash before commit", async () => {
    const doc = wf([step("s1", "test.echo"), step("s2", "test.echo"), step("s3", "test.echo")]);
    const id = await startRun(doc);
    const leaseMs = 30_000;
    let crash = true;
    const crashing = createExecutor({
      registry,
      storage,
      clock: clock.now,
      leaseMs,
      __testHooks: {
        beforeCommit: (_runId, stepPath, phase) => {
          if (crash && stepPath === "s2" && phase === "result") {
            crash = false;
            throw new Error("simulated crash");
          }
        },
      },
    });
    const lease = await storage.claimRun({ workerId: "w1", leaseMs, now: clock.now() });
    await expect(crashing.executeClaim(lease!, "w1")).rejects.toThrow("simulated crash");
    expect((await getRun(id)).status).toBe("running");

    const engine = makeEngine({ leaseMs });
    expect(await engine.runOnce()).toBe(false);
    clock.advance(leaseMs + 1);
    expect(await engine.runOnce()).toBe(true);

    const run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(calls).toEqual({ s1: 1, s2: 2, s3: 1 });
    expect(Object.keys(run.journal)).toEqual(["s1", "s2", "s3"]);
    const evs = await events(id);
    const forS2 = evs.filter((e) => e.stepPath === "s2").map((e) => e.type);
    expect(forS2).toEqual(["step.started", "step.started", "step.completed"]);
    expect(evs.filter((e) => e.type === "run.completed")).toHaveLength(1);
    // The lost attempt counts: the re-run is attempt 2.
    expect(run.journal.s2).toMatchObject({ attempts: 2 });
  });

  it("stops silently when its lease was taken over before commit", async () => {
    const leaseMs = 30_000;
    const gate = deferred();
    const entered = deferred();
    let first = true;
    behaviours.a = async () => {
      if (first) {
        first = false;
        entered.resolve();
        await gate.promise;
      }
      return { ok: true };
    };
    const id = await startRun(wf([step("a", "test.echo"), step("b", "test.echo")]));
    const slow = makeEngine({ leaseMs }).runOnce("slow");
    await entered.promise;

    clock.advance(leaseMs + 1);
    expect(await makeEngine({ leaseMs }).runOnce("fast")).toBe(true);
    expect((await getRun(id)).status).toBe("completed");

    gate.resolve();
    expect(await slow).toBe(true);
    const evs = await events(id);
    expect(evs.filter((e) => e.type === "run.completed")).toHaveLength(1);
    expect(evs.filter((e) => e.type === "step.completed" && e.workerId === "slow")).toHaveLength(0);
    expect((await getRun(id)).status).toBe("completed");
  });

  it("aborts the handler signal when lease renewal fails", async () => {
    const leaseMs = 40;
    const entered = deferred();
    let signal: AbortSignal | undefined;
    behaviours.a = (ctx) =>
      new Promise((resolve) => {
        signal = ctx.signal;
        entered.resolve();
        ctx.signal.addEventListener("abort", () => resolve({ aborted: true }));
      });
    const id = await startRun(wf([step("a", "test.echo")]));
    const running = makeEngine({ leaseMs }).runOnce("w1");
    await entered.promise;
    clock.advance(leaseMs + 1);
    expect(
      await storage.claimRun({ workerId: "thief", leaseMs: 60_000, now: clock.now() }),
    ).not.toBe(null);
    expect(await running).toBe(true);
    expect(signal?.aborted).toBe(true);
    const run = await getRun(id);
    expect(run.leaseOwner).toBe("thief");
    expect(run.journal).toEqual({});
    expect((await events(id)).map((e) => e.type)).toEqual(["run.started", "step.started"]);
  });
});

describe("executor: lost workers and lease renewal", () => {
  const leaseMs = 30_000;

  /** An executor whose `result` commits throw for matching paths, simulating a worker crash. */
  function crashingExecutor(failPath: (path: string) => boolean) {
    return createExecutor({
      registry,
      storage,
      clock: clock.now,
      leaseMs,
      __testHooks: {
        beforeCommit: (_runId, stepPath, phase) => {
          if (phase === "result" && failPath(stepPath)) throw new Error("simulated crash");
        },
      },
    });
  }

  async function crashOnce(ex: ReturnType<typeof createExecutor>) {
    const lease = await storage.claimRun({ workerId: "crashy", leaseMs, now: clock.now() });
    expect(lease).not.toBe(null);
    await expect(ex.executeClaim(lease!, "crashy")).rejects.toThrow("simulated crash");
    clock.advance(leaseMs + 1);
  }

  it("fails a step whose handler keeps killing the worker once retries are used up", async () => {
    const id = await startRun(wf([step("a", "test.echo"), step("b", "test.echo")]));
    const ex = crashingExecutor((p) => p === "a");
    for (let i = 0; i < 3; i++) await crashOnce(ex);
    expect(calls.a).toBe(3);

    const engine = makeEngine({ leaseMs });
    expect(await engine.runOnce()).toBe(true);
    const run = await getRun(id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({
      message: "worker lost during step (3 attempts)",
      stepPath: "a",
    });
    expect(run.journal.a).toMatchObject({ status: "failed", attempts: 3 });
    expect(calls.a).toBe(3);
    expect(calls.b).toBeUndefined();
    expect(await engine.drain()).toBe(0);
  });

  it("resumes a crashed forEach at the interrupted iteration", async () => {
    const id = await startRun(
      wf([
        step(
          "each",
          "test.forEach",
          { items: ["a", "b", "c"] },
          { branches: { body: [step("x", "test.echo", { value: { $ref: "loop.item" } })] } },
        ),
      ]),
    );
    let crash = true;
    const ex = crashingExecutor((p) => {
      if (crash && p === "each/body[1]/x") {
        crash = false;
        return true;
      }
      return false;
    });
    await crashOnce(ex);
    await makeEngine({ leaseMs }).drain();
    const run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(calls).toEqual({ "each/body[0]/x": 1, "each/body[1]/x": 2, "each/body[2]/x": 1 });
    expect(run.journal.each).toMatchObject({
      output: { count: 3, results: [{ value: "a" }, { value: "b" }, { value: "c" }] },
    });
  });

  it("renews the lease while a long handler runs so no other worker can claim the run", async () => {
    const shortLease = 60;
    // Fake clock, so a slow machine cannot let the lease lapse between two renewal ticks. The
    // handler waits (on a condition, not a delay) for an in-handler renewal to land.
    let renewed = deferred();
    const watched: StorageAdapter = {
      ...storage,
      renewLease: async (lease, ms, now) => {
        const ok = await storage.renewLease(lease, ms, now);
        renewed.resolve();
        return ok;
      },
    };
    let claimedMeanwhile: unknown = "not tried";
    behaviours.a = async () => {
      clock.advance(shortLease - 10);
      renewed = deferred();
      await renewed.promise;
      // Past the original lease (claim + 60): only the renewal keeps the run claimed.
      clock.advance(20);
      claimedMeanwhile = await storage.claimRun({
        workerId: "other",
        leaseMs: shortLease,
        now: clock.now(),
      });
      return { ok: true };
    };
    const id = await startRun(wf([step("a", "test.echo")]));
    await makeEngine({ storage: watched, leaseMs: shortLease }).runOnce("w1");
    expect(claimedMeanwhile).toBe(null);
    expect((await getRun(id)).status).toBe("completed");
    expect(calls.a).toBe(1);
  });

  it("keeps the claim when lease renewal throws transiently", async () => {
    let failures = 0;
    const recovered = deferred();
    const flaky: StorageAdapter = {
      ...storage,
      renewLease: async (lease, ms, now) => {
        if (failures < 2) {
          failures++;
          throw new Error("db hiccup");
        }
        const ok = await storage.renewLease(lease, ms, now);
        recovered.resolve();
        return ok;
      },
    };
    const warnings: string[] = [];
    const logger = { debug() {}, info() {}, warn: (m: string) => warnings.push(m), error() {} };
    // Run until renewal has failed twice and then succeeded, however slowly the ticks arrive.
    behaviours.a = async () => {
      await recovered.promise;
      return { ok: true };
    };
    const id = await startRun(wf([step("a", "test.echo")]));
    await createEngine({ registry, storage: flaky, leaseMs: 40, logger }).runOnce("w1");
    expect((await getRun(id)).status).toBe("completed");
    expect(warnings).toEqual(["lease renewal failed", "lease renewal failed"]);
  });

  it("keeps the claim when the between-steps lease renewal throws transiently", async () => {
    // Fake clock and a long lease: the in-handler renewal interval never fires, so the only
    // renewal is the one due before step b (step a moved the clock past half the lease).
    let failures = 0;
    const flaky: StorageAdapter = {
      ...storage,
      renewLease: async (lease, ms, now) => {
        if (failures < 1) {
          failures++;
          throw new Error("db hiccup");
        }
        return storage.renewLease(lease, ms, now);
      },
    };
    const warnings: string[] = [];
    const logger = { debug() {}, info() {}, warn: (m: string) => warnings.push(m), error() {} };
    behaviours.a = () => {
      clock.advance(leaseMs / 2 + 1);
      return { ok: true };
    };
    const id = await startRun(wf([step("a", "test.echo"), step("b", "test.echo")]));
    await makeEngine({ storage: flaky, leaseMs, logger }).runOnce("w1");
    expect((await getRun(id)).status).toBe("completed");
    expect(calls).toEqual({ a: 1, b: 1 });
    expect(warnings).toEqual(["lease renewal failed"]);
  });

  it("abandons the claim when between-steps renewals keep throwing", async () => {
    const broken: StorageAdapter = {
      ...storage,
      renewLease: async () => {
        throw new Error("db down");
      },
    };
    behaviours.a = () => {
      clock.advance(leaseMs / 2 + 1);
      return { ok: true };
    };
    const steps = ["a", "b", "c", "d", "e"].map((s) => step(s, "test.echo"));
    const id = await startRun(wf(steps));
    await makeEngine({ storage: broken, leaseMs }).runOnce("w1");
    // Renewal is due before b, c and d; the third consecutive error stops the claim before d.
    expect(calls).toEqual({ a: 1, b: 1, c: 1 });
    const run = await getRun(id);
    expect(run.status).toBe("running");
    expect(run.journal.d).toBeUndefined();
  });

  it("abandons the claim after three consecutive renewal errors", async () => {
    const broken: StorageAdapter = {
      ...storage,
      renewLease: async () => {
        throw new Error("db down");
      },
    };
    let signal: AbortSignal | undefined;
    behaviours.a = (ctx) =>
      new Promise((resolve) => {
        signal = ctx.signal;
        ctx.signal.addEventListener("abort", () => resolve({ aborted: true }));
      });
    const id = await startRun(wf([step("a", "test.echo")]));
    await createEngine({ registry, storage: broken, leaseMs: 40 }).runOnce("w1");
    expect(signal?.aborted).toBe(true);
    const run = await getRun(id);
    expect(run.status).toBe("running");
    expect(run.journal).toEqual({});
  });
});

describe("executor: retry details", () => {
  it("moves a timed-out step with retries left to waiting (retry), keeping default backoff", async () => {
    const id = await startRun(wf([step("slow", "test.slowRetry")]));
    const t0 = clock.t;
    await makeEngine().drain();
    const run = await getRun(id);
    expect(run).toMatchObject({ status: "waiting", waitReason: "retry", attempt: 2 });
    // `retry.backoff: undefined` must not erase the exponential default.
    expect(run.wakeAt).toBe(t0 + 1000);
    const retrying = (await events(id)).find((e) => e.type === "step.retrying");
    expect(retrying?.data).toEqual({ attempt: 1, delayMs: 1000, error: "timed out" });
  });

  it("keeps run.resume across a retry and clears it once the step settles", async () => {
    const seen: unknown[] = [];
    behaviours.a = (ctx) => {
      seen.push(ctx.resume);
      if (ctx.attempt === 1) throw new Error("transient");
      return { ok: true };
    };
    const v = await storage.saveWorkflowVersion(TENANT, wf([step("a", "test.echo")]), "u", clock.t);
    const resume = { kind: "callback" as const, body: { approved: true } };
    await storage.createRun(
      {
        id: "resumed",
        tenantId: TENANT,
        workflowId: "wf",
        version: v.version,
        status: "queued",
        trigger: {},
        journal: {},
        attempt: 1,
        startedBy: { kind: "manual" },
        resume,
      },
      [],
      clock.t,
    );
    const engine = makeEngine();
    await engine.drain();
    expect((await getRun("resumed")).resume).toEqual(resume);
    clock.advance(1000);
    await engine.drain();
    const run = await getRun("resumed");
    expect(run.status).toBe("completed");
    expect(seen).toEqual([resume, resume]);
    expect(run.resume).toBeUndefined();
  });

  it("carries the loop handler's attempts into the loop's done entry", async () => {
    behaviours.each = (ctx, input) => {
      if (ctx.attempt === 1) throw new Error("transient");
      return { items: (input as { items: unknown[] }).items };
    };
    const id = await startRun(
      wf([
        step(
          "each",
          "test.forEach",
          { items: [1] },
          { branches: { body: [step("x", "test.echo")] } },
        ),
      ]),
    );
    const engine = makeEngine();
    await engine.drain();
    clock.advance(1000);
    await engine.drain();
    const run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(run.journal.each).toMatchObject({ status: "done", attempts: 2 });
  });
});

describe("executor: messages and branch output", () => {
  it("accepts branch(id) without output even when the node declares an output schema", async () => {
    behaviours.cond = () => branch("if");
    const id = await startRun(
      wf([
        step(
          "cond",
          "test.ifElse",
          { cond: true },
          { branches: { if: [step("x", "test.echo", { value: { $ref: "steps.cond" } })] } },
        ),
      ]),
    );
    await makeEngine().drain();
    const run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(run.journal.cond).toMatchObject({ status: "done", branch: "if" });
    expect(run.journal["cond/if/x"]).toMatchObject({ output: { value: {} } });
  });

  it("names the first ref of a failing template as the source", async () => {
    const id = await startRun(
      wf([step("n", "test.numeric", { n: { $tpl: "{{trigger.count}} of {{trigger.total}}" } })]),
      { count: 2, total: 3 },
    );
    await makeEngine().drain();
    const message = (await getRun(id)).error?.message;
    expect(message).toContain('Step "n": field "n" ');
    expect(message).toContain('(from template "trigger.count")');
  });
});
