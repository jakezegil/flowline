import {
  branch,
  createRegistry,
  defineNode,
  definePlugin,
  type JournalEntry,
  type Step,
  type WorkflowDoc,
} from "@flowkit/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildScope, nextAction } from "./interpreter";

const registry = createRegistry([
  definePlugin({
    id: "t",
    name: "Test",
    nodes: [
      defineNode({ type: "t.a", name: "A", input: z.object({}), run: () => ({}) }),
      defineNode({
        type: "t.if",
        name: "If",
        input: z.object({}),
        branches: {
          kind: "static",
          branches: [
            { id: "if", label: "If" },
            { id: "else", label: "Else" },
          ],
        },
        run: () => branch("if"),
      }),
      defineNode({
        type: "t.each",
        name: "Each",
        input: z.object({ items: z.array(z.unknown()) }),
        branches: { kind: "loop", itemsField: "items", branch: "body" },
        run: ({ input }) => ({ items: input.items }),
      }),
    ],
  }),
]);

const s = (id: string, type = "t.a", extra: Partial<Step> = {}): Step => ({
  id,
  type,
  config: {},
  ...extra,
});

const done = (output: unknown): JournalEntry => ({
  status: "done",
  output,
  at: 1,
  startedAt: 1,
  attempts: 1,
});

function doc(steps: Step[]): WorkflowDoc {
  return { id: "wf", name: "WF", trigger: { type: "t.manual", config: {} }, steps };
}

describe("nextAction", () => {
  it("executes the first step without a journal entry", () => {
    const d = doc([s("a"), s("b")]);
    expect(nextAction(d, {}, registry)).toMatchObject({ type: "exec", path: "a", scopeFrames: [] });
    expect(nextAction(d, { a: done(1) }, registry)).toMatchObject({ type: "exec", path: "b" });
    expect(nextAction(d, { a: done(1), b: done(2) }, registry)).toEqual({ type: "complete" });
  });

  it("skips disabled steps once", () => {
    const d = doc([s("a", "t.a", { disabled: true }), s("b")]);
    expect(nextAction(d, {}, registry)).toMatchObject({ type: "skip", path: "a" });
    expect(nextAction(d, { a: { status: "skipped", at: 1 } }, registry)).toMatchObject({
      type: "exec",
      path: "b",
    });
  });

  it("descends into the taken branch and completes the block", () => {
    const d = doc([s("cond", "t.if", { branches: { if: [s("x")], else: [s("y")] } }), s("after")]);
    const branched: JournalEntry = {
      status: "branched",
      branch: "if",
      output: { ok: true },
      at: 1,
      startedAt: 1,
      attempts: 1,
    };
    expect(nextAction(d, { cond: branched }, registry)).toMatchObject({
      type: "exec",
      path: "cond/if/x",
      scopeFrames: [{ blockPath: "cond" }],
    });
    expect(nextAction(d, { cond: branched, "cond/if/x": done(1) }, registry)).toMatchObject({
      type: "completeBlock",
      path: "cond",
    });
  });

  it("completes a block whose taken branch is empty or missing", () => {
    const d = doc([s("cond", "t.if", { branches: { if: [s("x")] } })]);
    const entry: JournalEntry = {
      status: "branched",
      branch: "else",
      output: undefined,
      at: 1,
      startedAt: 1,
      attempts: 1,
    };
    expect(nextAction(d, { cond: entry }, registry)).toMatchObject({ type: "completeBlock" });
  });

  it("does not treat inherited property names as branches", () => {
    const d = doc([s("cond", "t.if", { branches: { if: [s("x")] } })]);
    const entry: JournalEntry = {
      status: "branched",
      branch: "constructor",
      output: undefined,
      at: 1,
      startedAt: 1,
      attempts: 1,
    };
    expect(nextAction(d, { cond: entry }, registry)).toMatchObject({ type: "completeBlock" });
  });

  it("iterates loop bodies with indexed paths and loop frames", () => {
    const d = doc([s("each", "t.each", { branches: { body: [s("x"), s("y")] } })]);
    const looping: JournalEntry = {
      status: "looping",
      items: ["a", "b"],
      results: [],
      at: 1,
      startedAt: 1,
    };
    expect(nextAction(d, { each: looping }, registry)).toMatchObject({
      type: "exec",
      path: "each/body[0]/x",
      scopeFrames: [{ blockPath: "each", loop: { item: "a", index: 0 } }],
    });
    const j = {
      each: looping,
      "each/body[0]/x": done(1),
      "each/body[0]/y": done(2),
    };
    expect(nextAction(d, j, registry)).toMatchObject({
      type: "exec",
      path: "each/body[1]/x",
      scopeFrames: [{ blockPath: "each", loop: { item: "b", index: 1 } }],
    });
    expect(
      nextAction(d, { ...j, "each/body[1]/x": done(3), "each/body[1]/y": done(4) }, registry),
    ).toMatchObject({ type: "completeBlock", path: "each" });
  });

  it("completes an empty loop immediately", () => {
    const d = doc([s("each", "t.each", { branches: { body: [s("x")] } })]);
    const looping: JournalEntry = {
      status: "looping",
      items: [],
      results: [],
      at: 1,
      startedAt: 1,
    };
    expect(nextAction(d, { each: looping }, registry)).toMatchObject({ type: "completeBlock" });
  });

  it("re-executes suspended and failed steps", () => {
    const d = doc([s("a")]);
    const failed: JournalEntry = {
      status: "failed",
      error: { message: "x" },
      at: 1,
      startedAt: 1,
      attempts: 1,
    };
    expect(nextAction(d, { a: failed }, registry)).toMatchObject({ type: "exec", path: "a" });
  });
});

describe("buildScope", () => {
  it("sees earlier siblings, enclosing blocks and the innermost loop", () => {
    const d = doc([
      s("first"),
      s("cond", "t.if", {
        branches: {
          if: [s("inner"), s("each", "t.each", { branches: { body: [s("x"), s("y")] } })],
        },
      }),
      s("last"),
    ]);
    const journal: Record<string, JournalEntry> = {
      first: done({ n: 1 }),
      cond: {
        status: "branched",
        branch: "if",
        output: undefined,
        at: 1,
        startedAt: 1,
        attempts: 1,
      },
      "cond/if/inner": done("in"),
      "cond/if/each": { status: "looping", items: [10, 20], results: [], at: 1, startedAt: 1 },
      "cond/if/each/body[0]/x": done("x0"),
      "cond/if/each/body[0]/y": done("y0"),
      "cond/if/each/body[1]/x": done("x1"),
    };
    const scope = buildScope(d, journal, "cond/if/each/body[1]/y", { t: 1 }, "run-1");
    expect(scope.trigger).toEqual({ t: 1 });
    expect(scope.run).toEqual({ id: "run-1" });
    expect(scope.loop).toEqual({ item: 20, index: 1 });
    expect({ ...scope.steps }).toEqual({ first: { n: 1 }, cond: {}, inner: "in", x: "x1" });
  });

  it("builds the end scope from top-level steps only", () => {
    const d = doc([s("a"), s("cond", "t.if", { branches: { if: [s("x")] } })]);
    const journal: Record<string, JournalEntry> = {
      a: done(1),
      cond: { status: "done", branch: "if", output: { m: true }, at: 1, startedAt: 1, attempts: 1 },
      "cond/if/x": done(2),
    };
    const scope = buildScope(d, journal, "", null, "r");
    expect({ ...scope.steps }).toEqual({ a: 1, cond: { m: true } });
    expect(scope.loop).toBeUndefined();
  });

  it("does not resolve inherited names as step outputs", () => {
    const scope = buildScope(doc([s("a")]), {}, "", null, "r");
    expect(scope.steps.constructor).toBeUndefined();
  });
});
