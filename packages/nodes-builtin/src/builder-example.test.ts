/**
 * The `workflow()` TSDoc example in `@flowlinejs/core`'s builder.ts, compiled and validated against
 * the real built-in nodes (core can't import them), plus compile-time checks of the condition
 * node's `rules` config type.
 */
import { createRegistry, ref, validateWorkflow, workflow } from "@flowlinejs/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import {
  and,
  builtinPlugin,
  conditionNode,
  delayNode,
  eq,
  eventTrigger,
  type RuleGroup,
  stopNode,
} from "./index";

describe("the workflow() TSDoc example", () => {
  it("compiles and validates", () => {
    // Keep in sync with packages/core/src/builder.ts.
    const dealWon = workflow("deal-won", { name: "Deal won follow-up" })
      .trigger(eventTrigger, { event: "deal.updated" })
      .step(
        "check",
        conditionNode,
        { rules: and(eq(ref("trigger.stage"), "won")) },
        {
          if: (b) => b.step("wait", delayNode, { duration: "2d" }),
          else: (b) => b.step("halt", stopNode, { reason: "Not won" }),
        },
      )
      .build();

    const manifest = createRegistry([builtinPlugin]).manifest();
    const issues = validateWorkflow(dealWon, manifest).filter((i) => i.severity === "error");
    expect(issues).toEqual([]);
  });
});

describe("condition rules are typed", () => {
  it("takes a RuleGroup, not unknown", () => {
    expectTypeOf<z.input<typeof conditionNode.input>["rules"]>().toEqualTypeOf<RuleGroup>();

    const build = () =>
      workflow("typed")
        .trigger(eventTrigger, { event: "x" })
        // @ts-expect-error a string isn't a rule group
        .step("bad", conditionNode, { rules: "garbage" })
        // @ts-expect-error the old array form isn't a rule group either
        .step("bad2", conditionNode, { rules: [{ left: 1, op: "eq", right: 1 }] })
        .build();
    expect(build).toBeTypeOf("function");
  });
});
