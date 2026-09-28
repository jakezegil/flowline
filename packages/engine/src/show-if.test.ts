import { defineNode, definePlugin, ui, type WorkflowDoc } from "@flowkit/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
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
});
