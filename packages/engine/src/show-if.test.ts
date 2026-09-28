import {
  createRegistry,
  defineNode,
  definePlugin,
  defineTrigger,
  ui,
  type WorkflowDoc,
} from "@flowlinejs/core";
import { createMemoryStorage } from "@flowlinejs/storage-memory";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createEngine } from "./engine";
import { runWorkflowInMemory } from "./testing";

const send = defineNode({
  type: "t.send",
  name: "Send",
  input: z.object({
    mode: z.enum(["none", "json"]).default("none"),
    body: ui(z.string().min(1), { showIf: { field: "mode", equals: "json" } }).optional(),
  }),
  run: ({ input }) => ({ keys: Object.keys(input).sort(), body: input.body ?? null }),
});
const plugin = definePlugin({ id: "t", name: "T", nodes: [send] });

const doc = (config: Record<string, unknown>): WorkflowDoc => ({
  id: "wf",
  name: "Send",
  trigger: {
    type: "core.manual",
    config: { fields: [{ name: "mode", type: "string" }] },
  },
  steps: [{ id: "s", type: "t.send", config: config as never }],
});

describe("showIf at run time", () => {
  it("drops hidden fields before the input is parsed, judged on resolved values", async () => {
    // The stale body would fail the parse; hidden, it never reaches the parser or the handler.
    const hidden = await runWorkflowInMemory(doc({ mode: "none", body: 5 }), {
      plugins: [plugin],
      trigger: {},
    });
    expect(hidden.run.status).toBe("completed");
    expect(hidden.run.journal.s).toMatchObject({ output: { keys: ["mode"], body: null } });

    const shown = await runWorkflowInMemory(doc({ mode: { $ref: "trigger.mode" }, body: "hi" }), {
      plugins: [plugin],
      trigger: { mode: "json" },
    });
    expect(shown.run.journal.s).toMatchObject({ output: { keys: ["body", "mode"], body: "hi" } });

    // The editor can't know a reference's value, but the engine judges the resolved one.
    const resolved = await runWorkflowInMemory(
      doc({ mode: { $ref: "trigger.mode" }, body: "hi" }),
      { plugins: [plugin], trigger: { mode: "none" } },
    );
    expect(resolved.run.journal.s).toMatchObject({ output: { keys: ["mode"], body: null } });
  });

  it("drops hidden fields inside the member of a discriminated union", async () => {
    const member = (type: string) =>
      z.object({
        type: z.literal(type),
        mode: z.enum(["a", "b"]).default("a"),
        extra: ui(z.string().min(3), { showIf: { field: "mode", equals: "b" } }).optional(),
      });
    const authNode = defineNode({
      type: "t.auth",
      name: "Auth",
      input: z.object({ auth: z.discriminatedUnion("type", [member("key"), member("basic")]) }),
      run: ({ input }) => ({ auth: input.auth }),
    });
    const authPlugin = definePlugin({ id: "t", name: "T", nodes: [authNode] });
    const authDoc = (auth: Record<string, unknown>): WorkflowDoc => ({
      id: "wf",
      name: "Auth",
      trigger: { type: "core.manual", config: {} },
      steps: [{ id: "s", type: "t.auth", config: { auth } as never }],
    });
    // "x" fails min(3), but it's hidden (mode "a"), so it is dropped, not rejected.
    const hidden = await runWorkflowInMemory(authDoc({ type: "key", extra: "x" }), {
      plugins: [authPlugin],
      trigger: {},
    });
    expect(hidden.run.status).toBe("completed");
    expect(hidden.run.journal.s).toMatchObject({ output: { auth: { type: "key", mode: "a" } } });
    expect(hidden.run.journal.s).not.toHaveProperty("output.auth.extra");

    const shown = await runWorkflowInMemory(authDoc({ type: "basic", mode: "b", extra: "long" }), {
      plugins: [authPlugin],
      trigger: {},
    });
    expect(shown.run.journal.s).toMatchObject({
      output: { auth: { type: "basic", mode: "b", extra: "long" } },
    });
  });
});

describe("showIf in trigger config", () => {
  const changed = defineTrigger({
    type: "t.changed",
    name: "Changed",
    kind: "event",
    event: "thing.changed",
    config: z.object({
      only: z.boolean().default(false),
      stage: ui(z.enum(["won", "lost"]), { showIf: { field: "only" } }).optional(),
      key: ui(z.string().min(3), { showIf: { field: "only" } }).optional(),
    }),
    payload: z.object({ id: z.string(), stage: z.string() }),
    filter: ({ config, payload }) => config.stage === undefined || payload.stage === config.stage,
    dedupeKey: ({ config }) => config.key,
  });
  const echo = defineNode({
    type: "t.echo",
    name: "Echo",
    input: z.object({ value: z.unknown() }),
    run: ({ input }) => ({ value: input.value }),
  });
  const registry = createRegistry([
    definePlugin({ id: "t", name: "T", nodes: [echo], triggers: [changed] }),
  ]);
  const setup = async (config: Record<string, unknown>) => {
    const storage = createMemoryStorage();
    const engine = createEngine({ registry, storage });
    const wf: WorkflowDoc = {
      id: "wf",
      name: "Changed",
      trigger: { type: "t.changed", config: config as never },
      steps: [{ id: "e", type: "t.echo", config: { value: { $ref: "trigger.id" } } }],
    };
    const v = await engine.saveWorkflow("t1", wf, "u");
    await engine.publish("t1", wf.id, v.version, "u");
    const emit = (stage: string) =>
      engine.emit("thing.changed", { id: "1", stage }, { tenantId: "t1" });
    return { emit, runs: () => storage.listRuns("t1", {}) };
  };

  it("filter and dedupeKey never see hidden fields", async () => {
    // stage and key are hidden (only: false): no filtering, no dedupe key.
    const hidden = await setup({ only: false, stage: "won", key: "fixed" });
    expect((await hidden.emit("lost")).started).toHaveLength(1);
    expect((await hidden.emit("lost")).started).toHaveLength(1);
    expect(await hidden.runs()).toHaveLength(2);

    const shown = await setup({ only: true, stage: "won", key: "fixed" });
    expect((await shown.emit("lost")).started).toEqual([]);
    expect((await shown.emit("won")).started).toHaveLength(1);
    expect((await shown.emit("won")).started).toEqual([]); // deduplicated by key "fixed"
    expect(await shown.runs()).toHaveLength(1);
  });

  it("a hidden value that fails its schema doesn't disable the trigger", async () => {
    const { emit, runs } = await setup({ only: false, stage: "nope", key: "x" });
    expect((await emit("lost")).started).toHaveLength(1);
    expect(await runs()).toHaveLength(1);
  });
});
