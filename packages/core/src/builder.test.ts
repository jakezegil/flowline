import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { type ConfigOf, type DeepExpr, ref, type TriggerConfigOf, tpl, workflow } from "./builder";
import { branch, defineNode, defineTrigger, FlowkitDefinitionError, stop } from "./define";
import { FlowkitRefError } from "./refs";
import type { RefExpr, TplExpr, WorkflowDoc } from "./types";

const dealUpdated = defineTrigger({
  type: "crm.dealUpdated",
  name: "Deal updated",
  kind: "event",
  event: "deal.updated",
  config: z.object({
    onlyWhenStageChanges: z.boolean().default(false),
    dedupeKey: z.string().optional(),
  }),
  payload: z.object({ deal: z.object({ stage: z.string(), name: z.string() }) }),
});

const scheduled = defineTrigger({
  type: "crm.scheduled",
  name: "Scheduled",
  kind: "schedule",
  config: z.object({ cron: z.string() }),
});

const condition = defineNode({
  type: "core.condition",
  name: "Condition",
  input: z.object({
    rules: z.array(z.object({ left: z.unknown(), op: z.enum(["eq", "neq"]), right: z.unknown() })),
  }),
  branches: {
    kind: "static",
    branches: [
      { id: "if", label: "If" },
      { id: "else", label: "Else" },
    ],
  },
  run: () => branch("if"),
});

const delay = defineNode({
  type: "core.delay",
  name: "Delay",
  input: z.object({ duration: z.string() }),
  run: () => ({}),
});

const halt = defineNode({
  type: "core.stop",
  name: "Stop",
  input: z.object({ reason: z.string().optional() }),
  run: ({ input }) => stop(input.reason),
});

const httpRequest = defineNode({
  type: "core.httpRequest",
  name: "HTTP request",
  input: z.object({
    url: z.string(),
    method: z.enum(["GET", "POST"]).default("GET"),
    headers: z.record(z.string(), z.string()).optional(),
    retries: z.number().optional(),
    tags: z.array(z.string()).optional(),
  }),
  run: () => ({}),
});

describe("workflow builder", () => {
  test("builds a doc with a condition and if/else branches", () => {
    const doc = workflow("deal-won", { name: "Deal won follow-up" })
      .trigger(dealUpdated, { onlyWhenStageChanges: true })
      .step(
        "check",
        condition,
        { rules: [{ left: ref("trigger.deal.stage"), op: "eq", right: "won" }] },
        {
          if: (b) =>
            b.step("wait", delay, { duration: "2d" }).step("notify", httpRequest, {
              url: "https://example.com/hook",
              method: "POST",
              headers: { "x-deal": tpl("Congrats on {{trigger.deal.name}}") },
            }),
          else: (b) => b.step("halt", halt, { reason: "Not won" }),
        },
      )
      .build();

    const expected: WorkflowDoc = {
      id: "deal-won",
      name: "Deal won follow-up",
      trigger: { type: "crm.dealUpdated", config: { onlyWhenStageChanges: true } },
      steps: [
        {
          id: "check",
          type: "core.condition",
          config: { rules: [{ left: { $ref: "trigger.deal.stage" }, op: "eq", right: "won" }] },
          branches: {
            if: [
              { id: "wait", type: "core.delay", config: { duration: "2d" } },
              {
                id: "notify",
                type: "core.httpRequest",
                config: {
                  url: "https://example.com/hook",
                  method: "POST",
                  headers: { "x-deal": { $tpl: "Congrats on {{trigger.deal.name}}" } },
                },
              },
            ],
            else: [{ id: "halt", type: "core.stop", config: { reason: "Not won" } }],
          },
        },
      ],
    };
    expect(doc).toEqual(expected);
  });

  test("defaults name to the id, includes description and output, omits empty extras", () => {
    const doc = workflow("sub-1", { description: "A sub-flow" })
      .trigger(scheduled, { cron: "* * * * *" })
      .step("wait", delay, { duration: "1m" })
      .output({ done: true, at: ref("steps.wait") })
      .build();
    expect(doc).toEqual({
      id: "sub-1",
      name: "sub-1",
      description: "A sub-flow",
      trigger: { type: "crm.scheduled", config: { cron: "* * * * *" } },
      steps: [{ id: "wait", type: "core.delay", config: { duration: "1m" } }],
      output: { done: true, at: { $ref: "steps.wait" } },
    });
  });

  test("trigger config may be omitted when all fields are optional", () => {
    const doc = workflow("wf").trigger(dealUpdated).build();
    expect(doc.trigger).toEqual({ type: "crm.dealUpdated", config: {} });
    expect(doc.steps).toEqual([]);
  });

  test("drops undefined config values", () => {
    const doc = workflow("wf")
      .trigger(dealUpdated)
      .step("req", httpRequest, { url: "https://x.test", headers: undefined })
      .build();
    expect(doc.steps[0]?.config).toEqual({ url: "https://x.test" });
    expect(Object.hasOwn(doc.steps[0]!.config, "headers")).toBe(false);
  });

  test("build() returns independent copies", () => {
    const b = workflow("wf").trigger(dealUpdated).step("a", delay, { duration: "1s" });
    const first = b.build();
    first.steps.push({ id: "x", type: "y", config: {} });
    expect(b.build().steps).toHaveLength(1);
  });

  test("build() throws without a trigger", () => {
    expect(() => workflow("wf").step("a", delay, { duration: "1s" }).build()).toThrow(
      /workflow "wf" has no trigger/,
    );
  });

  test("rejects invalid workflow ids", () => {
    expect(() => workflow("Bad Id")).toThrow(FlowkitDefinitionError);
    expect(() => workflow("Bad Id")).toThrow(/Invalid workflow id "Bad Id"/);
  });

  test("rejects invalid step ids", () => {
    const b = workflow("wf").trigger(dealUpdated);
    expect(() => b.step("1st", delay, { duration: "1s" })).toThrow(FlowkitDefinitionError);
    expect(() => b.step("has-dash", delay, { duration: "1s" })).toThrow(
      /Invalid step id "has-dash"/,
    );
  });

  test("rejects duplicate step ids, including across branches", () => {
    expect(() =>
      workflow("wf")
        .trigger(dealUpdated)
        .step("a", delay, { duration: "1s" })
        .step("a", delay, { duration: "1s" }),
    ).toThrow(/Duplicate step id "a"/);

    expect(() =>
      workflow("wf")
        .trigger(dealUpdated)
        .step("a", delay, { duration: "1s" })
        .step("check", condition, { rules: [] }, { if: (b) => b.step("a", halt, {}) }),
    ).toThrow(/Duplicate step id "a"/);
  });

  test("a branch callback must return the builder it was given", () => {
    expect(() =>
      workflow("wf")
        .trigger(dealUpdated)
        // @ts-expect-error — must return a StepsBuilder
        .step("check", condition, { rules: [] }, { if: () => undefined }),
    ).toThrow(/Branch "if" of step "check"/);
  });
});

describe("ref / tpl", () => {
  test("ref() builds a RefExpr and validates the path eagerly", () => {
    expect(ref("steps.load.emails[0]")).toEqual({ $ref: "steps.load.emails[0]" });
    expect(() => ref("nope.x")).toThrow(FlowkitRefError);
    expect(() => ref("steps.")).toThrow(FlowkitRefError);
    expectTypeOf(ref("trigger")).toEqualTypeOf<RefExpr>();
  });

  test("tpl() builds a TplExpr and validates embedded refs eagerly", () => {
    expect(tpl("Hi {{trigger.name}}")).toEqual({ $tpl: "Hi {{trigger.name}}" });
    expect(() => tpl("Hi {{bogus.name}}")).toThrow(FlowkitRefError);
    expectTypeOf(tpl("x")).toEqualTypeOf<TplExpr>();
  });
});

describe("ConfigOf typing", () => {
  type HttpConfig = ConfigOf<typeof httpRequest>;

  test("maps each input field to DeepExpr of its z.input type", () => {
    expectTypeOf<HttpConfig["url"]>().toEqualTypeOf<string | RefExpr | TplExpr>();
    expectTypeOf<DeepExpr<number>>().toEqualTypeOf<number | RefExpr | TplExpr>();
    expectTypeOf<TriggerConfigOf<typeof scheduled>>().toEqualTypeOf<{
      cron: string | RefExpr | TplExpr;
    }>();
  });

  test("accepts refs at the top level, nested in records and in array elements", () => {
    const ok: HttpConfig[] = [
      { url: ref("trigger.url") },
      { url: tpl("https://{{trigger.host}}/x"), headers: ref("steps.auth.headers") },
      { url: "https://x.test", headers: { authorization: ref("steps.auth.token") } },
      { url: "https://x.test", tags: [ref("trigger.tag"), "static", tpl("t-{{run.id}}")] },
      { url: "https://x.test", tags: ref("trigger.tags"), retries: ref("trigger.n") },
    ];
    expect(ok).toHaveLength(5);
  });

  test("rejects wrong literal types and missing required fields; allows omitting optional", () => {
    const optionalOmitted: HttpConfig = { url: "https://x.test" };
    expect(optionalOmitted.url).toBe("https://x.test");

    // @ts-expect-error — url must be a string
    const wrongType: HttpConfig = { url: 42 };
    // @ts-expect-error — method is an enum
    const wrongEnum: HttpConfig = { url: "u", method: "PATCH" };
    // @ts-expect-error — header values must be strings
    const wrongNested: HttpConfig = { url: "u", headers: { a: 1 } };
    // @ts-expect-error — tag elements must be strings
    const wrongElement: HttpConfig = { url: "u", tags: [1] };
    // @ts-expect-error — url is required
    const missing: HttpConfig = { method: "GET" };
    expect([wrongType, wrongEnum, wrongNested, wrongElement, missing]).toHaveLength(5);
  });

  test("step() and trigger() check config against the definitions", () => {
    const b = workflow("wf").trigger(dealUpdated, { onlyWhenStageChanges: ref("trigger.flag") });
    // @ts-expect-error — duration must be a string
    expect(() => b.step("a", delay, { duration: 5 })).not.toThrow();
    // @ts-expect-error — duration is required
    expect(() => b.step("b", delay, {})).not.toThrow();
    // @ts-expect-error — config is required for a trigger with required fields
    expect(() => workflow("wf2").trigger(scheduled)).not.toThrow();
    const wf3 = workflow("wf3");
    // @ts-expect-error — onlyWhenStageChanges must be boolean
    expect(() => wf3.trigger(dealUpdated, { onlyWhenStageChanges: "yes" })).not.toThrow();
  });
});
