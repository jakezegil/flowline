import { describe, expect, expectTypeOf, it } from "vitest";
import { FlowlineTreeError, walkSteps } from "../tree";
import type { Manifest, WorkflowDoc } from "../types";
import { UI_META_KEY } from "../ui";
import { validateWorkflow } from "../validate";
import { flatDoc, richManifest, specExampleDoc } from "./fixtures";
import type { FollowUp, ReadFn, ReadResults, ReadToolName, StepDetail } from "./read-types";
import {
  availableRefs,
  describeNodeTypes,
  findSteps,
  focus,
  getIssues,
  getSteps,
  listNodeTypes,
  reads,
} from "./reads";

const m: Manifest = richManifest();
const BODY = "x".repeat(20_000);

/**
 * `deal` and `recheck` (an If) in section `check`; `mail` (a 20k-char body) in `then`, `stop1`
 * in `else`; `later` after them, with a missing required field.
 */
function doc(): WorkflowDoc {
  return {
    id: "reads",
    name: "Reads",
    trigger: { type: "crm.dealStuckInStage", config: { stage: "proposal" } },
    steps: [
      {
        id: "deal",
        type: "crm.getDeal",
        name: "Load deal",
        color: "pink",
        note: "Loads it",
        config: { dealId: { $ref: "trigger.deal.id" } },
      },
      {
        id: "recheck",
        type: "flow.if",
        config: { value: true },
        branches: {
          // biome-ignore lint/suspicious/noThenProperty: a branch ID, not a thenable
          then: [
            {
              id: "mail",
              type: "crm.sendEmail",
              config: { to: { $ref: "steps.deal.deal.ownerId" }, subject: "Hi", body: BODY },
            },
          ],
          else: [{ id: "stop1", type: "flow.stop", config: {} }],
        },
      },
      { id: "later", type: "flow.delay", disabled: true, config: {} },
    ],
    sections: [
      {
        id: "check",
        title: "Check",
        color: "blue",
        note: "Section note",
        first: "deal",
        last: "recheck",
      },
    ],
  };
}

describe("focus", () => {
  it("cuts a 20 000-char config string to 500 chars, and full: true returns it whole", () => {
    const d = focus(doc(), m, { stepId: "mail" });
    expect(d.config?.body).toBe(`${"x".repeat(500)}…(+19.5k chars)`);
    expect(d.cut).toEqual(["config.body"]);
    expect(d.full).toEqual({ tool: "focus", args: { stepId: "mail", full: true } });
    const whole = focus(doc(), m, { stepId: "mail", full: true });
    expect(whole.config?.body).toBe(BODY);
    expect(whole.cut).toBeUndefined();
    expect(whole.full).toBeUndefined();
  });

  it("returns everything needed to edit the step", () => {
    const d = focus(doc(), m, { stepId: "deal" });
    expect(d).toMatchObject({
      id: "deal",
      type: "crm.getDeal",
      nodeLabel: "Get deal",
      name: "Load deal",
      note: "Loads it",
      color: "pink",
      section: { id: "check", title: "Check", color: "blue", note: "Section note" },
      location: { parentId: null, index: 0 },
      config: { dealId: { $ref: "trigger.deal.id" } },
      issues: [],
    });
    expect(d.schema).toEqual({
      type: "object",
      properties: { dealId: { type: "string" } },
      required: ["dealId"],
    });
    expect(d.branches).toBeUndefined();
  });

  it("sets section for a member, and not for a step outside it", () => {
    expect(focus(doc(), m, { stepId: "recheck" }).section?.id).toBe("check");
    expect(focus(doc(), m, { stepId: "later" }).section).toBeUndefined();
    // A step inside a member's branch isn't a member itself.
    expect(focus(doc(), m, { stepId: "mail" }).section).toBeUndefined();
  });

  it("refs lists the trigger and earlier steps only", () => {
    const refs = focus(doc(), m, { stepId: "mail" }).refs?.map((r) => r.ref);
    expect(refs).toEqual(["trigger", "steps.deal", "steps.recheck"]);
    const atDeal = focus(doc(), m, { stepId: "deal" }).refs?.map((r) => r.ref);
    expect(atDeal).toEqual(["trigger"]);
  });

  it("branches for a condition lists its branches with step counts", () => {
    const d = focus(doc(), m, { stepId: "recheck" });
    expect(d.branches).toEqual([
      { id: "then", label: "Then", steps: 1 },
      { id: "else", label: "Else", steps: 1 },
    ]);
  });

  it("location, disabled and issues", () => {
    const mail = focus(doc(), m, { stepId: "mail" });
    expect(mail.location).toEqual({ parentId: "recheck", branch: "then", index: 0 });
    const later = focus(doc(), m, { stepId: "later" });
    expect(later.disabled).toBe(true);
    expect(later.issues.map((i) => i.code)).toContain("config.required");
    expect(later.issues.every((i) => i.stepId === "later")).toBe(true);
  });

  it("throws a FlowlineTreeError for an unknown step", () => {
    expect(() => focus(doc(), m, { stepId: "nope" })).toThrow(FlowlineTreeError);
  });
});

describe("getSteps", () => {
  it("returns the given IDs in order, unknown ones in missing", () => {
    const r = getSteps(doc(), m, { ids: ["later", "nope", "deal"] });
    expect(r.steps.map((s) => s.id)).toEqual(["later", "deal"]);
    expect(r.missing).toEqual(["nope"]);
    expect(r.next).toBeUndefined();
  });

  it("include defaults to config; include: [] returns no config, schema or refs", () => {
    const [byDefault] = getSteps(doc(), m, { ids: ["deal"] }).steps;
    expect(byDefault?.config).toEqual({ dealId: { $ref: "trigger.deal.id" } });
    expect(byDefault?.schema).toBeUndefined();
    expect(byDefault?.refs).toBeUndefined();
    const [bare] = getSteps(doc(), m, { ids: ["deal"], include: [] }).steps;
    expect(bare).toBeDefined();
    expect(bare?.config).toBeUndefined();
    expect(bare?.schema).toBeUndefined();
    expect(bare?.refs).toBeUndefined();
    const [all] = getSteps(doc(), m, {
      ids: ["deal"],
      include: ["config", "schema", "refs"],
    }).steps;
    expect(all?.schema).toBeDefined();
    expect(all?.refs?.map((x) => x.ref)).toEqual(["trigger"]);
  });

  it("cuts long strings, with a full: true follow-up for the whole page", () => {
    const d = doc();
    const note = "n".repeat(700);
    (d.steps[0] as { note?: string }).note = note;
    const r = getSteps(d, m, { ids: ["deal", "mail", "later"] });
    expect(r.steps[0]?.note).toBe(`${"n".repeat(500)}…(+200 chars)`);
    expect(r.steps[0]?.cut).toEqual(["note"]);
    expect(r.steps[1]?.cut).toEqual(["config.body"]);
    expect(r.steps[2]?.cut).toBeUndefined();
    expect(r.full).toEqual({
      tool: "getSteps",
      args: { ids: ["deal", "mail"], include: ["config"], full: true },
    });
    const f = r.full as Extract<FollowUp, { tool: "getSteps" }>;
    const whole = getSteps(d, m, f.args);
    expect(whole.steps[0]?.note).toBe(note);
    expect(whole.steps[1]?.config?.body).toBe(BODY);
    expect(whole.full).toBeUndefined();
  });

  it("cuts nested config strings and names each path", () => {
    const d = doc();
    const long = "q".repeat(600);
    (d.steps[0] as { config: unknown }).config = {
      dealId: { $tpl: long },
      list: ["short", long],
      deep: { inner: long },
    };
    const [s] = getSteps(d, m, { ids: ["deal"] }).steps;
    expect(s?.cut).toEqual(["config.dealId", "config.list[1]", "config.deep.inner"]);
    expect(s?.config?.dealId).toEqual({ $tpl: `${"q".repeat(500)}…(+100 chars)` });
    const [f] = getSteps(d, m, { ids: ["deal"], full: true }).steps;
    expect(f?.config).toEqual(d.steps[0]?.config);
  });

  it("the where form pages in pre-order with after, limit and next", () => {
    const d = flatDoc(120);
    const first = getSteps(d, m, { where: {} });
    expect(first.steps).toHaveLength(50);
    expect(first.steps[0]?.id).toBe("step_1");
    expect(first.next).toEqual({ tool: "getSteps", args: { where: {}, after: "step_50" } });
    const second = getSteps(d, m, (first.next as { args: { where: object; after: string } }).args);
    expect(second.steps.map((s) => s.id)).toEqual(
      Array.from({ length: 50 }, (_, i) => `step_${i + 51}`),
    );
    const third = getSteps(d, m, { where: {}, after: "step_100", limit: 30 });
    expect(third.steps.map((s) => s.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `step_${i + 101}`),
    );
    expect(third.next).toBeUndefined();
    const small = getSteps(d, m, { where: { type: "crm.getDeal" }, limit: 2, include: [] });
    expect(small.steps.map((s) => s.id)).toEqual(["step_1", "step_3"]);
    expect(small.next).toEqual({
      tool: "getSteps",
      args: { where: { type: "crm.getDeal" }, limit: 2, include: [], after: "step_3" },
    });
    expect(small.missing).toEqual([]);
  });

  it("limit is capped at 200", () => {
    const r = getSteps(flatDoc(500), m, { where: {}, limit: 1000, include: [] });
    expect(r.steps).toHaveLength(200);
    expect(r.next?.args).toMatchObject({ after: "step_200" });
  });

  it("an after that isn't a step throws", () => {
    expect(() => getSteps(flatDoc(3), m, { where: {}, after: "nope" })).toThrow(FlowlineTreeError);
  });

  it("with full: true, a step returns the full note of the section it heads or contains (C5)", () => {
    const d = doc();
    const long = "s".repeat(4000);
    (d.sections?.[0] as { note?: string }).note = long;
    const [cut] = getSteps(d, m, { ids: ["deal"], include: [] }).steps;
    expect(cut?.section?.note).toBe(`${"s".repeat(500)}…(+3.5k chars)`);
    expect(cut?.cut).toEqual(["section.note"]);
    const [whole] = getSteps(d, m, { ids: ["deal"], include: [], full: true }).steps;
    expect(whole?.section?.note).toBe(long);
    // A member that doesn't head it gets it too.
    const [member] = getSteps(d, m, { ids: ["recheck"], include: [], full: true }).steps;
    expect(member?.section?.note).toBe(long);
  });

  it("a step returns the sections it heads that don't contain it (broken, overlapping)", () => {
    const d = doc();
    d.sections = [
      ...(d.sections ?? []),
      {
        id: "broken",
        title: "Broken",
        color: "green",
        note: "b".repeat(900),
        first: "later",
        last: "gone",
      },
    ];
    const [s] = getSteps(d, m, { ids: ["later"], include: [], full: true }).steps;
    expect(s?.section).toBeUndefined();
    expect(s?.heads).toEqual([
      { id: "broken", title: "Broken", color: "green", note: "b".repeat(900) },
    ]);
  });

  it("the config follow-up from outline, then full: true, reaches the full content (M-1)", () => {
    const d = flatDoc(60, { configChars: 20_000 });
    const page = getSteps(d, m, { where: {}, include: ["config"], limit: 50 });
    const s1 = page.steps.find((s) => s.id === "step_1");
    expect(s1?.cut).toEqual(["config.dealId"]);
    expect(String(s1?.config?.dealId)).toMatch(/…\(\+19\.5k chars\)$/);
    expect(page.full?.tool).toBe("getSteps");
    const f = page.full as FollowUp;
    const whole = reads[f.tool](d, m, f.args as never) as ReadResults["getSteps"];
    expect(whole.steps.find((s) => s.id === "step_1")?.config?.dealId).toBe("y".repeat(20_000));
  });
});

describe("findSteps", () => {
  it("counts matches with one-line summaries", () => {
    const r = findSteps(doc(), m, { where: { type: "crm.sendEmail" } });
    expect(r).toEqual({ count: 1, matches: [{ id: "mail", line: "mail  Send email" }] });
  });

  it("{} returns every step, lines in the outline format", () => {
    const r = findSteps(doc(), m, { where: {} });
    expect(r.count).toBe(5);
    expect(r.matches.map((x) => x.id)).toEqual(["deal", "recheck", "mail", "stop1", "later"]);
    expect(r.matches[0]?.line).toBe('deal  Get deal “Load deal” [pink]: note "Loads it"');
    expect(r.matches[4]?.line).toMatch(/^later {2}Delay \(disabled\) · \d+ issues?$/);
  });

  it("section includes the members' subtrees", () => {
    expect(findSteps(doc(), m, { where: { section: "check" } }).matches.map((x) => x.id)).toEqual([
      "deal",
      "recheck",
      "mail",
      "stop1",
    ]);
  });
});

describe("availableRefs", () => {
  it("top level: the trigger and earlier steps, with their types", () => {
    const r = availableRefs(doc(), m, { stepId: "mail" });
    expect(r.refs).toEqual([
      { ref: "trigger", type: "{ deal }", label: "Deal stuck in stage", children: 1 },
      { ref: "steps.deal", type: "{ deal }", label: "Load deal", children: 1 },
      { ref: "steps.recheck", type: "{ matched }", label: "If", children: 1 },
    ]);
  });

  it("path drills into child properties, typed with describeType", () => {
    const r = availableRefs(doc(), m, { stepId: "mail", path: "steps.deal.deal" });
    expect(r.refs).toEqual([
      { ref: "steps.deal.deal.id", type: "string", label: "id" },
      { ref: "steps.deal.deal.stage", type: "string", label: "stage" },
      { ref: "steps.deal.deal.ownerId", type: "string", label: "ownerId" },
    ]);
    expect(availableRefs(doc(), m, { stepId: "mail", path: "steps.deal" }).refs).toEqual([
      { ref: "steps.deal.deal", type: "{ id, stage, ownerId }", label: "deal", children: 3 },
    ]);
  });

  it("marks a disabled step's refs", () => {
    const d = doc();
    d.steps.push({ id: "after", type: "flow.stop", config: {} });
    const refs = availableRefs(d, m, { stepId: "after" }).refs;
    expect(refs.find((x) => x.ref === "steps.later")?.disabled).toBe(true);
  });

  it("throws for an unknown step or a path out of scope", () => {
    expect(() => availableRefs(doc(), m, { stepId: "nope" })).toThrow(FlowlineTreeError);
    expect(() => availableRefs(doc(), m, { stepId: "deal", path: "steps.later" })).toThrow(
      FlowlineTreeError,
    );
    expect(() => availableRefs(doc(), m, { stepId: "mail", path: "steps.deal.nope" })).toThrow(
      FlowlineTreeError,
    );
    expect(() => availableRefs(doc(), m, { stepId: "mail", path: "not a ref" })).toThrow(
      FlowlineTreeError,
    );
  });
});

describe("listNodeTypes", () => {
  it("ranks by label, type and keyword matches", () => {
    const r = listNodeTypes(null, m, { query: "mail" });
    expect(r.types.map((t) => t.type)).toEqual(["crm.sendEmail", "crm.syncList"]);
    expect(r.types[1]).toEqual({
      type: "crm.syncList",
      label: "Sync list",
      description: "Push contacts to a mailing list.",
      category: "Marketing",
    });
  });

  it("category filters, with or without a query", () => {
    const logic = listNodeTypes(null, m, { category: "logic" }).types.map((t) => t.type);
    expect(logic).toEqual([
      "flow.if",
      "flow.stop",
      "flow.delay",
      "flow.switch",
      "flow.forEach",
      "flow.condition",
    ]);
    expect(
      listNodeTypes(null, m, { category: "CRM", query: "mail" }).types.map((t) => t.type),
    ).toEqual(["crm.sendEmail"]);
  });

  it("no args lists every type in manifest order", () => {
    expect(listNodeTypes(doc(), m, {}).types).toHaveLength(m.nodes.length);
  });
});

describe("describeNodeTypes", () => {
  const r = describeNodeTypes(null, m, {
    types: ["flow.if", "flow.switch", "flow.forEach", "flow.condition", "crm.getDeal", "nope"],
  });
  const byType = (t: string) => r.types.find((x) => x.type === t);

  it("static, fromConfig and loop branches", () => {
    expect(byType("flow.if")?.branches).toEqual({ kind: "static", ids: ["then", "else"] });
    expect(byType("flow.switch")?.branches).toEqual({
      kind: "fromConfig",
      fromConfig: "cases[].id",
      ids: ["default"],
    });
    expect(byType("flow.forEach")?.branches).toEqual({ kind: "loop", ids: ["body"] });
    expect(byType("crm.getDeal")?.branches).toEqual({ kind: "none" });
  });

  it("unknown types land in unknown", () => {
    expect(r.unknown).toEqual(["nope"]);
    expect(r.types.map((t) => t.type)).toEqual([
      "flow.if",
      "flow.switch",
      "flow.forEach",
      "flow.condition",
      "crm.getDeal",
    ]);
  });

  it("output and custom operators", () => {
    expect(byType("crm.getDeal")?.output).toMatchObject({
      type: "object",
      properties: { deal: { type: "object" } },
    });
    expect(byType("flow.condition")?.operators).toEqual([
      { id: "isUnassigned", label: "is unassigned", arity: "unary" },
    ]);
    expect(byType("flow.if")?.operators).toBeUndefined();
  });

  it("input keeps only label, widget and enumLabels of x-flowline", () => {
    for (const t of r.types) {
      const seen: string[] = [];
      JSON.stringify(t.input, (k, v) => {
        if (k === UI_META_KEY) seen.push(...Object.keys(v as object));
        return v;
      });
      for (const k of seen) expect(["label", "widget", "enumLabels"]).toContain(k);
    }
    expect(JSON.stringify(byType("flow.switch")?.input)).toContain('"widget":"cases"');
  });

  it("a field-declared output is described by its config path", () => {
    const withFields: Manifest = {
      ...m,
      nodes: [
        ...m.nodes,
        {
          type: "x.set",
          plugin: "x",
          name: "Set",
          input: {},
          output: { kind: "fields", configPath: "fields" },
          branches: { kind: "none" },
        },
      ],
    };
    expect(describeNodeTypes(null, withFields, { types: ["x.set"] }).types[0]?.output).toEqual({
      declaredBy: "config.fields",
    });
  });
});

describe("getIssues", () => {
  it("all issues, or one step's, with counts", () => {
    const d = doc();
    const all = getIssues(d, m, {});
    expect(all.issues).toEqual(validateWorkflow(d, m));
    expect(all.errors + all.warnings).toBe(all.issues.length);
    const one = getIssues(d, m, { stepId: "later" });
    expect(one.issues.length).toBeGreaterThan(0);
    expect(one.issues.every((i) => i.stepId === "later")).toBe(true);
    expect(getIssues(d, m, { stepId: "nope" })).toEqual({ issues: [], errors: 0, warnings: 0 });
  });
});

describe("reads", () => {
  it("each read is callable uniformly from a follow-up", () => {
    const d = doc();
    const calls: [FollowUp, string][] = [
      [{ tool: "overview", args: {} }, "text"],
      [{ tool: "outline", args: { stepId: "recheck", branch: "then" } }, "text"],
      [{ tool: "focus", args: { stepId: "mail" } }, "id"],
      [{ tool: "getSteps", args: { ids: ["deal"] } }, "steps"],
      [{ tool: "findSteps", args: { where: {} } }, "count"],
      [{ tool: "availableRefs", args: { stepId: "mail" } }, "refs"],
      [{ tool: "listNodeTypes", args: { query: "mail" } }, "types"],
      [{ tool: "describeNodeTypes", args: { types: ["flow.if"] } }, "types"],
      [{ tool: "getIssues", args: {} }, "issues"],
    ];
    expect(new Set(calls.map(([f]) => f.tool))).toEqual(new Set(Object.keys(reads)));
    for (const [f, key] of calls) {
      const result = reads[f.tool](d, m, f.args as never);
      expect(result).toBeDefined();
      expect(result).toHaveProperty(key);
    }
  });

  it("each read has the uniform signature", () => {
    expectTypeOf(reads.focus).toEqualTypeOf<ReadFn<"focus">>();
    expectTypeOf(reads.getSteps).toEqualTypeOf<ReadFn<"getSteps">>();
    expectTypeOf(focus).toExtend<ReadFn<"focus">>();
    expectTypeOf(getSteps).toExtend<ReadFn<"getSteps">>();
    expectTypeOf(findSteps).toExtend<ReadFn<"findSteps">>();
    expectTypeOf(availableRefs).toExtend<ReadFn<"availableRefs">>();
    expectTypeOf(listNodeTypes).toExtend<ReadFn<"listNodeTypes">>();
    expectTypeOf(describeNodeTypes).toExtend<ReadFn<"describeNodeTypes">>();
    expectTypeOf(getIssues).toExtend<ReadFn<"getIssues">>();
    expectTypeOf<ReturnType<ReadFn<"focus">>>().toEqualTypeOf<StepDetail>();
    expectTypeOf<keyof typeof reads>().toEqualTypeOf<ReadToolName>();
  });

  it("a legacy doc with broken sections reads through every read without throwing", () => {
    const d = specExampleDoc();
    d.sections = [
      { id: "noFirst", title: "No first", color: "blue", first: "gone", last: "recheck" },
      { id: "split", title: "Split", color: "green", first: "getDeal", last: "stopMoved" },
      { id: "reversed", title: "Reversed", color: "pink", first: "delay_1m", last: "getDeal" },
      { id: "a", title: "A", color: "yellow", first: "getDeal", last: "recheck" },
      { id: "b", title: "B", color: "purple", first: "recheck", last: "delay_1m" },
      {
        id: "red",
        title: "Red",
        color: "red" as never,
        note: "r".repeat(5000),
        first: "delay_1m",
        last: "delay_1m",
      },
    ];
    const ids: string[] = [];
    walkSteps(d, (s) => ids.push(s.id));
    const calls: FollowUp[] = [
      { tool: "overview", args: {} },
      { tool: "outline", args: {} },
      ...ids.map((stepId): FollowUp => ({ tool: "focus", args: { stepId } })),
      { tool: "getSteps", args: { ids, include: ["config", "schema", "refs"], full: true } },
      { tool: "getSteps", args: { where: { section: "red" } } },
      ...d.sections.map(
        (s): FollowUp => ({ tool: "findSteps", args: { where: { section: s.id } } }),
      ),
      { tool: "availableRefs", args: { stepId: "delay_1m" } },
      { tool: "listNodeTypes", args: {} },
      { tool: "describeNodeTypes", args: { types: ["flow.if"] } },
      { tool: "getIssues", args: {} },
    ];
    for (const f of calls) expect(() => reads[f.tool](d, m, f.args as never)).not.toThrow();
    const red = getSteps(d, m, { ids: ["delay_1m"], include: [] }).steps[0];
    expect(red?.section).toMatchObject({ id: "red", color: "gray" });
    expect(red?.cut).toEqual(["section.note"]);
    expect(getIssues(d, m, {}).issues.some((i) => i.code === "section.broken")).toBe(true);
  });
});
