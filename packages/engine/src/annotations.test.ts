import {
  createRegistry,
  defineNode,
  definePlugin,
  type Step,
  type WorkflowDetail,
  type WorkflowDoc,
} from "@flowlinejs/core";
import { createMemoryStorage } from "@flowlinejs/storage-memory";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createEngine } from "./engine";

const echo = defineNode({
  type: "t.echo",
  name: "Echo",
  input: z.object({ value: z.string() }),
  run: ({ input }) => ({ value: input.value }),
});
const registry = createRegistry([definePlugin({ id: "t", name: "T", nodes: [echo] })]);

function plain(id: string): WorkflowDoc {
  const s = (sid: string, value: unknown): Step => ({
    id: sid,
    type: "t.echo",
    config: { value: value as never },
  });
  return {
    id,
    name: "Annotated",
    trigger: { type: "core.manual", config: { fields: [{ name: "stage", type: "string" }] } },
    steps: [
      s("first", { $ref: "trigger.stage" }),
      {
        id: "check",
        type: "core.condition",
        config: {
          rules: {
            combinator: "and",
            rules: [{ left: { $ref: "trigger.stage" }, op: "eq", right: "won" }],
          },
        },
        branches: {
          if: [s("yes", "celebrate"), s("yes2", { $tpl: "won {{ steps.first.value }}" })],
          else: [s("no", "keep going")],
        },
      },
      s("last", { $ref: "steps.first.value" }),
    ],
  };
}

/** `plain(id)` with notes, colours and sections on it. */
function annotated(id: string): WorkflowDoc {
  const doc = plain(id);
  const [first, check, last] = doc.steps as [Step, Step, Step];
  return {
    ...doc,
    steps: [
      { ...first, note: "Reads the stage", color: "yellow" },
      {
        ...check,
        color: "purple",
        branches: {
          ...check.branches,
          if: (check.branches?.if ?? []).map((s) => ({ ...s, note: "n".repeat(5000) })),
        },
      },
      { ...last, color: "red" as Step["color"] },
    ],
    sections: [
      {
        id: "top",
        title: "Top",
        color: "blue",
        note: "The whole flow",
        first: "first",
        last: "last",
      },
      { id: "won", title: "Won", color: "green", first: "yes", last: "yes2" },
      { id: "bad", title: "Bad", color: "red" as "gray", first: "gone", last: "last" },
    ],
  };
}

function setup() {
  const now = Date.UTC(2026, 0, 1);
  const engine = createEngine({
    registry,
    storage: createMemoryStorage(),
    clock: () => now,
    authorize: async () => ({ tenantId: "t1", userId: "u1" }),
  });
  async function runOf(doc: WorkflowDoc, stage: string) {
    const v = await engine.saveWorkflow("t1", doc, "u1");
    await engine.publish("t1", doc.id, v.version, "u1");
    const runId = await engine.start({ tenantId: "t1", workflowId: doc.id, input: { stage } });
    await engine.drain();
    const detail = await engine.getRunDetail("t1", runId);
    return detail?.run;
  }
  return { engine, runOf };
}

describe("annotations at run time", () => {
  it("a workflow with and without notes, colours and sections runs identically", async () => {
    const { runOf } = setup();
    for (const stage of ["won", "lost"]) {
      const a = await runOf(plain("wf-plain"), stage);
      const b = await runOf(annotated("wf-annotated"), stage);
      expect(a?.status).toBe("completed");
      expect(Object.keys(a?.journal ?? {})).toContain(stage === "won" ? "check/if/yes2" : "last");
      expect(b?.status).toBe(a?.status);
      expect(b?.journal).toEqual(a?.journal);
      expect(b?.output).toEqual(a?.output);
    }
  });

  it("saveWorkflow → getWorkflow round-trips notes, colours and sections", async () => {
    const { engine } = setup();
    const doc = annotated("wf-round");
    await engine.saveWorkflow("t1", doc, "u1");
    const res = await engine.handler(new Request("http://localhost/flowline/workflows/wf-round"));
    expect(res.status).toBe(200);
    const detail = (await res.json()) as WorkflowDetail;
    expect(detail.latest.doc).toEqual(doc);
    expect(detail.latest.doc.sections).toEqual(doc.sections);
    expect(detail.latest.doc.steps[0]).toMatchObject({ note: "Reads the stage", color: "yellow" });
  });
});
