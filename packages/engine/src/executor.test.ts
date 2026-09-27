import {
  branch,
  createRegistry,
  defineNode,
  definePlugin,
  defineTrigger,
  type NodeContext,
  type RunEvent,
  type Step,
  sensitive,
  stop,
  suspend,
  type WorkflowDoc,
} from "@flowkit/core";
import { createMemoryStorage } from "@flowkit/storage-memory";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createEngine, type EngineOptions } from "./engine";
import { FatalError, RetryableError } from "./errors";
import { createExecutor } from "./executor";
import type { StorageAdapter } from "./storage";

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
        run: ({ input }) => ({ items: input.items }),
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
        input: z.object({ apiKey: sensitive(z.string()), name: z.string() }),
        output: z.object({ token: sensitive(z.string()), ok: z.boolean() }),
        run: () => ({ token: "tok-123", ok: true }),
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
      defineNode({
        type: "test.suspend",
        name: "Suspend",
        input: z.object({}),
        run: ({ ctx }) => suspend({ until: ctx.now() + 1000 }),
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
    const types = (await events(id)).map((e) => e.type);
    expect(types).toContain("run.stopped");
    expect(types).not.toContain("run.completed");
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

  it("fails fatally for signals that are not supported yet", async () => {
    const id = await startRun(wf([step("s", "test.suspend")]));
    await makeEngine().drain();
    const run = await getRun(id);
    expect(run.status).toBe("failed");
    expect(run.error?.message).toContain("not supported");
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
  it("masks sensitive input and output fields in the journal and events, then applies redact", async () => {
    const id = await startRun(
      wf([step("s", "test.secretive", { apiKey: "hunter2", name: "visible" })]),
    );
    await makeEngine({
      redact: (e) => (e.type === "step.completed" ? { ...e, data: { scrubbed: true } } : e),
    }).drain();
    const run = await getRun(id);
    expect(run.journal.s).toMatchObject({
      input: { apiKey: "[redacted]", name: "visible" },
      output: { token: "[redacted]", ok: true },
    });
    const evs = await events(id);
    expect(evs.find((e) => e.type === "step.started")?.data).toEqual({
      input: { apiKey: "[redacted]", name: "visible" },
    });
    expect(evs.find((e) => e.type === "step.completed")?.data).toEqual({ scrubbed: true });
    expect(JSON.stringify({ run, evs })).not.toContain("hunter2");
    expect(JSON.stringify({ run, evs })).not.toContain("tok-123");
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
        beforeCommit: (_runId, stepPath) => {
          if (crash && stepPath === "s2") {
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
