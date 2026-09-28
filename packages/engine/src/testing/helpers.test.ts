import { defineNode, definePlugin, sensitive, type WorkflowDoc } from "@flowkit/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runWorkflowInMemory, testNode } from "./index";

const greet = defineNode({
  type: "t.greet",
  name: "Greet",
  input: z.object({ name: z.string(), punctuation: z.string().default("!") }),
  output: z.object({ text: z.string(), by: z.string() }),
  run: ({ input, ctx }) => ({ text: `Hi ${input.name}${input.punctuation}`, by: ctx.stepId }),
});

const secretive = defineNode({
  type: "t.secretive",
  name: "Secretive",
  input: z.object({}),
  output: z.object({ pin: sensitive(z.string()) }),
  run: () => ({ pin: "1234" }),
});

const plugin = definePlugin({ id: "t", name: "T", nodes: [greet, secretive] });

describe("testNode", () => {
  it("runs a handler with parsed input and a default context", async () => {
    expect(await testNode(greet, { name: "Ada" })).toEqual({ text: "Hi Ada!", by: "test" });
  });

  it("accepts context overrides", async () => {
    const out = await testNode(greet, { name: "Ada", punctuation: "?" }, { stepId: "custom" });
    expect(out).toEqual({ text: "Hi Ada?", by: "custom" });
  });

  it("rejects invalid input", async () => {
    await expect(testNode(greet, { name: 5 } as never)).rejects.toThrow();
  });
});

describe("runWorkflowInMemory", () => {
  const doc: WorkflowDoc = {
    id: "wf",
    name: "Greeting",
    trigger: {
      type: "core.manual",
      config: { fields: [{ name: "name", type: "string", required: true }] },
    },
    steps: [
      { id: "wait", type: "core.delay", config: { duration: "2d" } },
      { id: "hello", type: "t.greet", config: { name: { $ref: "trigger.name" } } },
    ],
  };

  it("runs a workflow to completion, advancing the clock through timers", async () => {
    const start = Date.UTC(2026, 0, 1);
    const { run, events } = await runWorkflowInMemory(doc, {
      plugins: [plugin],
      trigger: { name: "Ada" },
      clock: () => start,
    });
    expect(run.status).toBe("completed");
    expect(run.journal.hello).toMatchObject({ output: { text: "Hi Ada!" } });
    expect(run.journal.wait).toMatchObject({ output: { resumedAt: "2026-01-03T00:00:00.000Z" } });
    expect(events.map((e) => e.type)).toEqual([
      "run.started",
      "step.started",
      "run.suspended",
      "run.resumed",
      "step.started",
      "step.completed",
      "step.started",
      "step.completed",
      "run.completed",
    ]);
  });

  it("rejects an invalid workflow", async () => {
    const bad = { ...doc, steps: [{ id: "x", type: "t.missing", config: {} }] };
    await expect(runWorkflowInMemory(bad, { plugins: [plugin] })).rejects.toMatchObject({
      name: "FlowkitValidationError",
    });
  });

  it("uses a real clock by default", async () => {
    const quick: WorkflowDoc = {
      ...doc,
      trigger: { type: "core.manual", config: {} },
      steps: [{ id: "s", type: "t.secretive", config: {} }],
    };
    const { run } = await runWorkflowInMemory(quick, { plugins: [plugin] });
    expect(run.status).toBe("completed");
  });
});
