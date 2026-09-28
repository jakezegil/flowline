/**
 * The `core.callSubflow` node.
 *
 * @module
 */
import { defineNode, FatalError, invokeSubflow, ui } from "@flowkit/core";
import { z } from "zod";

/**
 * Runs another published workflow (one with a `core.subflow` trigger) and waits for it. The step's
 * output is the sub-flow's output; a failed sub-flow fails the step.
 */
export const callSubflowNode = defineNode({
  type: "core.callSubflow",
  name: "Run sub-flow",
  description:
    "Run another workflow with the input you map, wait for it to finish and use its output.",
  icon: "workflow",
  category: "Sub-flows",
  keywords: ["subflow", "call", "workflow", "reuse"],
  summary: "Run sub-flow {{workflowId}}",
  input: z.object({
    workflowId: ui(z.string().min(1, "Choose a sub-flow"), {
      label: "Sub-flow",
      widget: "subflowSelect",
      literalOnly: true,
    }),
    input: ui(z.record(z.string(), z.unknown()), { label: "Input", widget: "subflowInput" }),
  }),
  dynamicOutput: { kind: "subflow", configPath: "workflowId" },
  run: ({ input, ctx }) => {
    if (ctx.resume?.kind === "subflow") return ctx.resume.output ?? {};
    if (ctx.resume?.kind === "subflowFailed") {
      throw new FatalError(ctx.resume.error.message);
    }
    return invokeSubflow({ workflowId: input.workflowId, input: input.input });
  },
});
