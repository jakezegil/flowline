/**
 * `core.transform`: user JavaScript evaluated in the engine's sandbox (`ctx.transform`).
 *
 * @module
 */
import { defineNode, FatalError, fields, ui } from "@flowkit/core";
import { z } from "zod";

/** Time limit of one transform evaluation, in ms. */
const TIMEOUT_MS = 1000;
/** Memory limit of one transform evaluation, in bytes. */
const MEMORY_BYTES = 64 * 1024 * 1024;

/**
 * `core.transform`: run a JavaScript snippet that computes the step's output from earlier data.
 * The code is a function body that `return`s an object; `trigger`, `steps` and `loop` (and
 * `input`, holding all three) are in scope. It runs in the engine's sandbox with a 1 s / 64 MB
 * limit and no network, file system or timers. The output shape is declared by `outputFields`.
 */
export const transform = defineNode({
  type: "core.transform",
  name: "Transform",
  description: "Compute values with a JavaScript snippet.",
  icon: "code",
  category: "Data",
  summary: "Transform data",
  input: z.object({
    code: ui(z.string(), {
      label: "Code",
      widget: "code",
      multiline: true,
      placeholder: "return { total: steps.load.items.length };",
    }),
    outputFields: ui(fields(), { label: "Output fields" }),
  }),
  dynamicOutput: { kind: "fields", configPath: "outputFields" },
  async run({ input, ctx }) {
    const result = await ctx.transform.run(input.code, ctx.scope, {
      timeoutMs: TIMEOUT_MS,
      memoryBytes: MEMORY_BYTES,
    });
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new FatalError("Transform code must return an object");
    }
    return result as Record<string, unknown>;
  },
});
