import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  branch,
  defineNode,
  definePlugin,
  isSignal,
  type NodeResult,
  secret,
  sensitive,
  type WorkflowDoc,
} from "@flowlinejs/core";
import { describe, expect, expectTypeOf, it } from "vitest";
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

/** Posts to `baseUrl` with the secret `token` as a bearer credential, through `ctx.http`. */
const post = defineNode({
  type: "t.post",
  name: "Post",
  input: z.object({ baseUrl: z.string(), token: secret() }),
  output: z.object({ messageId: z.string() }),
  retry: { max: 1 },
  run: async ({ input, ctx }) => {
    const res = await ctx.http.fetch(input.baseUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${await ctx.secrets.get(input.token)}` },
    });
    const body = (await res.json()) as { id: string };
    return { messageId: body.id };
  },
});

const size = defineNode({
  type: "t.size",
  name: "Size",
  input: z.object({ amount: z.number() }),
  output: z.object({ amount: z.number() }),
  branches: {
    kind: "static",
    branches: [
      { id: "small", label: "Small" },
      { id: "large", label: "Large" },
    ],
  },
  run: ({ input }) => branch(input.amount > 10 ? "large" : "small", input),
});

const plugin = definePlugin({ id: "t", name: "T", nodes: [greet, secretive, post, size] });

describe("testNode", () => {
  it("runs a handler with parsed input and a default context", async () => {
    expect(await testNode(greet, { name: "Ada" })).toEqual({ text: "Hi Ada!", by: "test" });
  });

  it("accepts context overrides", async () => {
    const out = await testNode(greet, { name: "Ada", punctuation: "?" }, { stepId: "custom" });
    expect(out).toEqual({ text: "Hi Ada?", by: "custom" });
  });

  it("types the result as the node's output or a signal", async () => {
    const out = await testNode(greet, { name: "Ada" });
    expectTypeOf(out).toEqualTypeOf<NodeResult<{ text: string; by: string }>>();
    if (isSignal(out)) throw new Error("expected output");
    expectTypeOf(out.text).toEqualTypeOf<string>();
    expect(out.text).toBe("Hi Ada!");
    expect(await testNode(size, { amount: 50 })).toMatchObject({ branch: "large" });
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
      name: "FlowlineValidationError",
    });
  });

  it("passes secrets and the network policy through, for nodes calling a local API", async () => {
    const seen: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "m_1" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const post: WorkflowDoc = {
        id: "post",
        name: "Post",
        trigger: { type: "core.manual", config: {} },
        steps: [
          {
            id: "p",
            type: "t.post",
            config: { baseUrl: `http://127.0.0.1:${port}`, token: "CHAT_TOKEN" },
          },
        ],
      };
      const blocked = await runWorkflowInMemory(post, {
        plugins: [plugin],
        secrets: { CHAT_TOKEN: "tok" },
      });
      expect(blocked.run.status).toBe("failed");
      const { run } = await runWorkflowInMemory(post, {
        plugins: [plugin],
        secrets: { CHAT_TOKEN: "tok" },
        http: { allowPrivateNetworks: true },
      });
      expect(run.status).toBe("completed");
      expect(run.journal.p).toMatchObject({ output: { messageId: "m_1" } });
      expect(seen).toEqual(["Bearer tok"]);
      // A name that isn't listed is not configured, as in production.
      const missing = await runWorkflowInMemory(post, {
        plugins: [plugin],
        secrets: {},
        http: { allowPrivateNetworks: true },
      });
      expect(missing.run.error?.message).toContain('Secret "CHAT_TOKEN" is not configured');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("publishes sub-flows first, so a workflow calling one validates and runs", async () => {
    const child: WorkflowDoc = {
      id: "child",
      name: "Child",
      trigger: {
        type: "core.subflow",
        config: {
          input: [{ name: "name", type: "string", required: true }],
          output: [{ name: "text", type: "string", required: true }],
        },
      },
      steps: [{ id: "g", type: "t.greet", config: { name: { $ref: "trigger.name" } } }],
      output: { text: { $ref: "steps.g.text" } },
    };
    const parent: WorkflowDoc = {
      ...doc,
      id: "parent",
      steps: [
        {
          id: "call",
          type: "core.callSubflow",
          config: { workflowId: "child", input: { name: { $ref: "trigger.name" } } },
        },
      ],
    };
    await expect(
      runWorkflowInMemory(parent, { plugins: [plugin], trigger: { name: "Ada" } }),
    ).rejects.toThrow('calls sub-flow "child"');
    const { run } = await runWorkflowInMemory(parent, {
      plugins: [plugin],
      trigger: { name: "Ada" },
      subflows: [child],
    });
    expect(run.status).toBe("completed");
    expect(run.journal.call).toMatchObject({ output: { text: "Hi Ada!" } });
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
