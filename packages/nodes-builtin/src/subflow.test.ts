import { describe, expect, it } from "vitest";
import { fakeContext } from "../test/fake-context";
import { callSubflowNode } from "./subflow";

const input = callSubflowNode.input.parse({
  workflowId: "get-or-create",
  input: { email: "a@b.c" },
});

describe("core.callSubflow", () => {
  it("starts the sub-flow with the mapped input", async () => {
    expect(await callSubflowNode.run({ input, ctx: fakeContext() })).toMatchObject({
      kind: "subflow",
      workflowId: "get-or-create",
      input: { email: "a@b.c" },
    });
  });

  it("returns the sub-flow's output", async () => {
    const ctx = fakeContext({ resume: { kind: "subflow", output: { id: "c1" } } });
    expect(await callSubflowNode.run({ input, ctx })).toEqual({ id: "c1" });
  });

  it("returns an empty object when the sub-flow has no output", async () => {
    const ctx = fakeContext({ resume: { kind: "subflow", output: undefined } });
    expect(await callSubflowNode.run({ input, ctx })).toEqual({});
  });

  it("fails without retrying when the sub-flow failed", async () => {
    const ctx = fakeContext({
      resume: { kind: "subflowFailed", error: { message: "Contact API down" } },
    });
    const err = (await (async () => callSubflowNode.run({ input, ctx }))().catch(
      (e: unknown) => e,
    )) as Error;
    expect(err).toBeInstanceOf(Error);
    // The engine recognises fatal errors by name.
    expect(err.name).toBe("FatalError");
    expect(err.message).toBe("Contact API down");
  });

  it("requires a workflow", () => {
    expect(callSubflowNode.input.safeParse({ workflowId: "", input: {} }).success).toBe(false);
  });
});
