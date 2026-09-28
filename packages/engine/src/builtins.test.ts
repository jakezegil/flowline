import {
  createRegistry,
  defineNode,
  definePlugin,
  type JournalEntry,
  loop,
  ref,
  tpl,
  type WorkflowDoc,
  workflow,
} from "@flowkit/core";
import {
  and,
  builtinPlugin,
  callSubflowNode,
  conditionNode,
  delayNode,
  eq,
  forEachNode,
  manualTrigger,
  stopNode,
  subflowTrigger,
  switchNode,
  waitForCallbackNode,
} from "@flowkit/nodes-builtin";
import { createMemoryStorage } from "@flowkit/storage-memory";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createEngine, type Engine } from "./engine";
import type { StorageAdapter } from "./storage";

const TENANT = "t1";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Echoes its value, so tests can see what a step resolved. */
const echo = defineNode({
  type: "t.echo",
  name: "Echo",
  input: z.object({ value: z.unknown() }),
  run: ({ input }) => ({ value: input.value }),
});
const testPlugin = definePlugin({ id: "t", name: "Test", nodes: [echo] });

let storage: StorageAdapter;
let now: number;
let engine: Engine;
let runSeq = 0;

beforeEach(() => {
  storage = createMemoryStorage();
  now = Date.UTC(2026, 0, 1);
  engine = createEngine({
    registry: createRegistry([testPlugin]),
    storage,
    clock: () => now,
    publicUrl: "https://crm.example",
  });
});

async function publish(doc: WorkflowDoc) {
  const v = await storage.saveWorkflowVersion(TENANT, doc, "user", now);
  await storage.publishVersion(TENANT, doc.id, v.version, now);
  return v;
}

async function start(doc: WorkflowDoc, trigger: unknown = {}): Promise<string> {
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

const outputAt = (journal: Record<string, JournalEntry>, path: string) => {
  const e = journal[path];
  return e && "output" in e ? e.output : undefined;
};

describe("createEngine registers the built-ins", () => {
  it("adds the core plugin to the host registry", () => {
    expect(engine.registry.getNode("core.condition")).toBe(conditionNode);
    expect(engine.registry.getNode("t.echo")).toBe(echo);
    expect(engine.registry.manifest().plugins.map((p) => p.id)).toEqual(["core", "t"]);
  });

  it("uses a registry that already has the core plugin as is", () => {
    const registry = createRegistry([builtinPlugin, testPlugin]);
    expect(createEngine({ registry, storage }).registry).toBe(registry);
  });

  it("leaves them out with builtins: false", () => {
    const registry = createRegistry([testPlugin]);
    const bare = createEngine({ registry, storage, builtins: false });
    expect(bare.registry).toBe(registry);
    expect(bare.registry.getNode("core.condition")).toBeUndefined();
  });
});

describe("core.condition", () => {
  const doc = workflow("deal-won")
    .trigger(manualTrigger, { fields: [{ name: "stage", type: "string" }] })
    .step(
      "check",
      conditionNode,
      { rules: and(eq(ref("trigger.stage"), "won")) },
      {
        if: (b) => b.step("yes", echo, { value: "celebrate" }),
        else: (b) => b.step("no", echo, { value: tpl("still {{trigger.stage}}") }),
      },
    )
    .step("after", echo, { value: ref("steps.check.matched") })
    .build();

  it("takes the If path when the rules match", async () => {
    const id = await start(doc, { stage: "won" });
    await engine.drain();
    const run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(run.journal.check).toMatchObject({ status: "done", branch: "if" });
    expect(outputAt(run.journal, "check/if/yes")).toEqual({ value: "celebrate" });
    expect(run.journal["check/else/no"]).toBeUndefined();
    expect(outputAt(run.journal, "after")).toEqual({ value: true });
  });

  it("takes the Else path otherwise", async () => {
    const id = await start(doc, { stage: "lost" });
    await engine.drain();
    const run = await getRun(id);
    expect(run.journal.check).toMatchObject({ status: "done", branch: "else" });
    expect(outputAt(run.journal, "check/else/no")).toEqual({ value: "still lost" });
    expect(outputAt(run.journal, "after")).toEqual({ value: false });
  });
});

describe("core.switch", () => {
  const doc = workflow("route")
    .trigger(manualTrigger, { fields: [{ name: "tier", type: "string" }] })
    .step(
      "route",
      switchNode,
      {
        value: ref("trigger.tier"),
        cases: [
          { id: "gold", label: "Gold", value: "gold" },
          { id: "silver", label: "Silver", value: "silver" },
        ],
      },
      {
        gold: (b) => b.step("g", echo, { value: "gold" }),
        default: (b) => b.step("d", echo, { value: "fallback" }),
      },
    )
    .build();

  it("runs a matching case", async () => {
    const id = await start(doc, { tier: "gold" });
    await engine.drain();
    const run = await getRun(id);
    expect(run.journal.route).toMatchObject({ branch: "gold", output: { matched: "gold" } });
    expect(outputAt(run.journal, "route/gold/g")).toEqual({ value: "gold" });
  });

  it("falls through to Default", async () => {
    const id = await start(doc, { tier: "bronze" });
    await engine.drain();
    const run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(run.journal.route).toMatchObject({ branch: "default", output: { matched: "default" } });
    expect(outputAt(run.journal, "route/default/d")).toEqual({ value: "fallback" });
  });

  it("completes a case without steps", async () => {
    const id = await start(doc, { tier: "silver" });
    await engine.drain();
    const run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(run.journal.route).toMatchObject({ branch: "silver" });
  });
});

describe("core.forEach", () => {
  it("runs the body per item with loop.item in templates", async () => {
    const doc = workflow("greet")
      .trigger(manualTrigger, { fields: [{ name: "contacts", type: "array" }] })
      .step(
        "each",
        forEachNode,
        { items: ref("trigger.contacts") },
        {
          body: (b) =>
            b.step("greet", echo, { value: tpl("Hi {{loop.item.name}} (#{{loop.index}})") }),
        },
      )
      .step("total", echo, { value: ref("steps.each.count") })
      .build();
    const id = await start(doc, { contacts: [{ name: "Ada" }, { name: "Bob" }] });
    await engine.drain();
    const run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(outputAt(run.journal, "each/body[0]/greet")).toEqual({ value: "Hi Ada (#0)" });
    expect(outputAt(run.journal, "each/body[1]/greet")).toEqual({ value: "Hi Bob (#1)" });
    expect(outputAt(run.journal, "each")).toEqual({
      count: 2,
      results: [{ value: "Hi Ada (#0)" }, { value: "Hi Bob (#1)" }],
    });
    expect(outputAt(run.journal, "total")).toEqual({ value: 2 });
  });
});

describe("core.stop", () => {
  it("ends the run successfully and skips later steps", async () => {
    const doc = workflow("halt")
      .trigger(manualTrigger, {})
      .step("halt", stopNode, { reason: "Nothing to do" })
      .step("never", echo, { value: 1 })
      .build();
    const id = await start(doc);
    await engine.drain();
    const run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ stoppedAt: "halt", reason: "Nothing to do" });
    expect(run.journal.never).toBeUndefined();
  });
});

describe("core.delay", () => {
  it("waits for the duration on the engine clock", async () => {
    const doc = workflow("nudge")
      .trigger(manualTrigger, {})
      .step("wait", delayNode, { duration: "2h" })
      .step("after", echo, { value: ref("steps.wait.resumedAt") })
      .build();
    const id = await start(doc);
    await engine.drain();
    let run = await getRun(id);
    expect(run).toMatchObject({ status: "waiting", waitReason: "timer", wakeAt: now + 2 * HOUR });

    now += HOUR;
    await engine.drain();
    expect((await getRun(id)).status).toBe("waiting");

    now += HOUR;
    await engine.drain();
    run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(outputAt(run.journal, "after")).toEqual({ value: "2026-01-01T02:00:00.000Z" });
  });

  it("waits until a date and time", async () => {
    const doc = workflow("later")
      .trigger(manualTrigger, {})
      .step("wait", delayNode, { until: "2026-01-02T09:00:00Z" })
      .build();
    const id = await start(doc);
    await engine.drain();
    expect((await getRun(id)).wakeAt).toBe(Date.parse("2026-01-02T09:00:00Z"));
  });

  it("fails clearly when neither a duration nor a time is set", async () => {
    const doc = workflow("unset").trigger(manualTrigger, {}).step("wait", delayNode, {}).build();
    const id = await start(doc);
    await engine.drain();
    expect((await getRun(id)).error).toMatchObject({
      message: 'Step "wait": Set how long to wait, or the date and time to wait until',
      fatal: true,
    });
  });
});

describe("core.waitForCallback", () => {
  const doc = workflow("approval")
    .trigger(manualTrigger, {})
    .step(
      "wait",
      waitForCallbackNode,
      { timeout: "1d" },
      {
        resumed: (b) => b.step("ok", echo, { value: ref("steps.wait.body.approved") }),
        timeout: (b) => b.step("late", echo, { value: ref("steps.wait.timedOut") }),
      },
    )
    .build();

  it("takes Resumed with the callback body", async () => {
    const id = await start(doc);
    await engine.drain();
    const waiting = await getRun(id);
    expect(waiting).toMatchObject({
      status: "waiting",
      waitReason: "callback",
      wakeAt: now + DAY,
    });
    expect(await engine.resumeRun(TENANT, id, { approved: true }, "u1")).toBe("resumed");
    await engine.drain();
    const run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(run.journal.wait).toMatchObject({
      status: "done",
      branch: "resumed",
      output: { body: { approved: true }, timedOut: false },
    });
    expect(outputAt(run.journal, "wait/resumed/ok")).toEqual({ value: true });
  });

  it("resumes through the callback token", async () => {
    const id = await start(doc);
    await engine.drain();
    const token = (await getRun(id)).callbackToken as string;
    expect(await engine.resume(token, { approved: false })).toBe("resumed");
    await engine.drain();
    const run = await getRun(id);
    expect(outputAt(run.journal, "wait/resumed/ok")).toEqual({ value: false });
  });

  it("takes Timed out when nobody calls back in time", async () => {
    const id = await start(doc);
    await engine.drain();
    now += DAY;
    await engine.drain();
    const run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(run.journal.wait).toMatchObject({
      branch: "timeout",
      output: { body: null, timedOut: true },
    });
    expect(outputAt(run.journal, "wait/timeout/late")).toEqual({ value: true });
  });

  it("takes Timed out for a callback arriving exactly at expiresAt", async () => {
    const id = await start(doc);
    await engine.drain();
    const waiting = await getRun(id);
    expect(waiting.callbackExpiresAt).toBe(now + DAY);
    now = waiting.callbackExpiresAt as number;
    expect(await engine.resume(waiting.callbackToken as string, { approved: true })).toBe("gone");
    await engine.drain();
    const run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(run.journal.wait).toMatchObject({ branch: "timeout", output: { timedOut: true } });
    expect(outputAt(run.journal, "wait/resumed/ok")).toBeUndefined();
  });
});

describe("loop()", () => {
  it("fails a step that isn't a looping node", async () => {
    const looper = defineNode({
      type: "t.looper",
      name: "Looper",
      input: z.object({}),
      run: () => loop([1, 2]),
    });
    const registry = createRegistry([definePlugin({ id: "t", name: "Test", nodes: [looper] })]);
    engine = createEngine({ registry, storage, clock: () => now });
    const doc: WorkflowDoc = {
      id: "loops",
      name: "Loops",
      trigger: { type: "core.manual", config: {} },
      steps: [{ id: "l", type: "t.looper", config: {} }],
    };
    const id = await start(doc);
    await engine.drain();
    expect((await getRun(id)).error).toMatchObject({
      message: 'Step "l": loop() is only for looping nodes',
      fatal: true,
    });
  });
});

describe("durations over 365 days", () => {
  it("fail the delay step with a clear message", async () => {
    const doc: WorkflowDoc = {
      id: "forever",
      name: "Forever",
      trigger: { type: "core.manual", config: {} },
      steps: [{ id: "wait", type: "core.delay", config: { duration: "400d" } }],
    };
    const id = await start(doc);
    await engine.drain();
    expect((await getRun(id)).error).toMatchObject({
      message: expect.stringContaining("Durations can be at most 365d"),
      fatal: true,
    });
  });
});

describe("core.callSubflow", () => {
  const child = (output: Record<string, unknown>) =>
    workflow("get-or-create", { name: "Get or create contact" })
      .trigger(subflowTrigger, {
        input: [{ name: "email", type: "string", required: true }],
        output: [
          { name: "contactId", type: "string", required: true },
          { name: "created", type: "boolean" },
        ],
      })
      .step("lookup", echo, { value: tpl("c-{{trigger.email}}") })
      .output(output as never)
      .build();

  const parent = workflow("parent")
    .trigger(manualTrigger, { fields: [{ name: "email", type: "string" }] })
    .step("call", callSubflowNode, {
      workflowId: "get-or-create",
      input: { email: ref("trigger.email") },
    })
    .step("after", echo, { value: ref("steps.call.contactId") })
    .build();

  it("runs the sub-flow and returns its declared output", async () => {
    await publish(child({ contactId: ref("steps.lookup.value"), created: true }));
    const id = await start(parent, { email: "ada@example.com" });
    await engine.drain();
    const run = await getRun(id);
    expect(run.status).toBe("completed");
    expect(outputAt(run.journal, "call")).toEqual({
      contactId: "c-ada@example.com",
      created: true,
    });
    expect(outputAt(run.journal, "after")).toEqual({ value: "c-ada@example.com" });
  });

  it("fails the sub-flow when its output doesn't match the declared fields", async () => {
    await publish(child({ contactId: 42 }));
    const id = await start(parent, { email: "ada@example.com" });
    await engine.drain();
    const [childRun] = await storage.listRuns(TENANT, { workflowId: "get-or-create" });
    expect(childRun).toMatchObject({
      status: "failed",
      error: { message: 'Sub-flow output: field "contactId" must be of type string', fatal: true },
    });
    const run = await getRun(id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({
      stepPath: "call",
      message: 'Sub-flow output: field "contactId" must be of type string',
    });
  });

  it("fails the sub-flow when a required output field is missing", async () => {
    await publish(child({ created: false }));
    const id = await start(parent, { email: "ada@example.com" });
    await engine.drain();
    const run = await getRun(id);
    expect(run.error?.message).toBe('Sub-flow output: field "contactId" is required');
  });

  it("checks the output of a sub-flow that stops early", async () => {
    const stopping = workflow("get-or-create")
      .trigger(subflowTrigger, {
        input: [],
        output: [{ name: "contactId", type: "string", required: true }],
      })
      .step("lookup", echo, { value: 7 })
      .step("halt", stopNode, { reason: "Found" })
      .output({ contactId: ref("steps.lookup.value") } as never)
      .build();
    await publish(stopping);
    const id = await start(parent, { email: "ada@example.com" });
    await engine.drain();
    const run = await getRun(id);
    expect(run.error?.message).toBe('Sub-flow output: field "contactId" must be of type string');
  });

  it("doesn't check the output of a sub-flow run started directly", async () => {
    const id = await start(child({ contactId: 42 }), { email: "ada@example.com" });
    await engine.drain();
    expect((await getRun(id)).status).toBe("completed");
  });
});
