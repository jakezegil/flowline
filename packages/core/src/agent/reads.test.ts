import { describe, expect, expectTypeOf, it } from "vitest";
import { FlowlineTreeError, walkSteps } from "../tree";
import type { Manifest, WorkflowDoc } from "../types";
import { UI_META_KEY } from "../ui";
import { validateWorkflow } from "../validate";
import { deepDoc, flatDoc, richManifest, specExampleDoc } from "./fixtures";
import type {
  FollowUp,
  ReadArgs,
  ReadFn,
  ReadResults,
  ReadToolName,
  StepDetail,
} from "./read-types";
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
    // Its own issues don't repeat its ID.
    expect(later.issues.every((i) => !("stepId" in i))).toBe(true);
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
    // The page-level `full` covers the steps; they carry no follow-up of their own.
    expect(r.steps.some((x) => x.full !== undefined)).toBe(false);
    const f = r.full as Extract<FollowUp, { tool: "getSteps" }>;
    const whole = getSteps(d, m, { ...f.args, budget: 100_000 });
    expect(whole.steps[0]?.note).toBe(note);
    expect(whole.steps[1]?.config?.body).toBe(BODY);
    expect(whole.full).toBeUndefined();
    // Within the default budget, the 20k body doesn't fit next to the first step.
    const tight = getSteps(d, m, f.args);
    expect(tight.steps.map((x) => x.id)).toEqual(["deal"]);
    expect(tight.next).toEqual({
      tool: "getSteps",
      args: { ids: ["mail"], include: ["config"], full: true },
    });
    expect(tight.remaining).toBe(1);
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
    const budget = 1_000_000;
    const first = getSteps(d, m, { where: {}, budget });
    expect(first.steps).toHaveLength(50);
    expect(first.steps[0]?.id).toBe("step_1");
    expect(first.next).toEqual({
      tool: "getSteps",
      args: { where: {}, budget, after: "step_50" },
    });
    const second = getSteps(d, m, (first.next as Extract<FollowUp, { tool: "getSteps" }>).args);
    expect(second.steps.map((s) => s.id)).toEqual(
      Array.from({ length: 50 }, (_, i) => `step_${i + 51}`),
    );
    const third = getSteps(d, m, { where: {}, after: "step_100", limit: 30, budget });
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
    const r = getSteps(flatDoc(500), m, { where: {}, limit: 1000, include: [], budget: 1e6 });
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
    expect(() => getIssues(d, m, { stepId: "nope" })).toThrow(FlowlineTreeError);
  });
});

describe("input errors", () => {
  it("an unknown within.stepId, within.branch or section throws, as focus does", () => {
    const d = doc();
    for (const where of [
      { within: { stepId: "nope" } },
      { within: { stepId: "recheck", branch: "maybe" } },
      { section: "nope" },
    ]) {
      expect(() => findSteps(d, m, { where })).toThrow(FlowlineTreeError);
      expect(() => getSteps(d, m, { where })).toThrow(FlowlineTreeError);
    }
    expect(() => findSteps(d, m, { where: { section: "nope" } })).toThrow(
      'where.section: unknown section "nope"',
    );
    // A declared branch with no steps yet is fine.
    const empty = doc();
    (empty.steps[1] as { branches?: unknown }).branches = {};
    expect(
      findSteps(empty, m, { where: { within: { stepId: "recheck", branch: "else" } } }).count,
    ).toBe(0);
  });

  it("an unknown Where key or a wrong field type throws", () => {
    const d = doc();
    expect(() => findSteps(d, m, { where: { nameContain: "x" } as never })).toThrow(
      'where: unknown key "nameContain"',
    );
    expect(() => findSteps(d, m, { where: { type: 3 } as never })).toThrow(FlowlineTreeError);
    expect(() => findSteps(d, m, { where: "all" as never })).toThrow(FlowlineTreeError);
    expect(() =>
      findSteps(d, m, { where: { within: { stepId: "recheck", x: 1 } } as never }),
    ).toThrow(FlowlineTreeError);
  });

  it("getSteps rejects a non-array ids, and args with neither ids nor where", () => {
    expect(() => getSteps(doc(), m, { ids: "deal" as never })).toThrow(
      "getSteps: `ids` must be an array of step IDs",
    );
    expect(() => getSteps(doc(), m, {} as never)).toThrow(FlowlineTreeError);
  });
});

describe("findSteps paging", () => {
  it("limit defaults to 100, with an omitted follow-up for the next page", () => {
    const d = flatDoc(250);
    const first = findSteps(d, m, { where: {} });
    expect(first.count).toBe(250);
    expect(first.matches).toHaveLength(100);
    expect(first.omitted).toEqual([
      {
        what: "steps",
        count: 150,
        fetch: { tool: "findSteps", args: { where: {}, after: "step_100" } },
      },
    ]);
    const seen = first.matches.map((x) => x.id);
    let o = first.omitted?.[0];
    while (o) {
      const r = reads[o.fetch.tool](d, m, o.fetch.args as never) as ReadResults["findSteps"];
      seen.push(...r.matches.map((x) => x.id));
      o = r.omitted?.[0];
    }
    expect(seen).toEqual(Array.from({ length: 250 }, (_, i) => `step_${i + 1}`));
    const small = findSteps(d, m, { where: { type: "crm.getDeal" }, limit: 2 });
    expect(small.matches.map((x) => x.id)).toEqual(["step_1", "step_3"]);
    expect(small.count).toBe(125);
    expect(findSteps(d, m, { where: {}, limit: 5000 }).matches).toHaveLength(250);
  });
});

describe("edge cases", () => {
  it("a step whose node type isn't in the manifest", () => {
    const d = doc();
    d.steps.push({
      id: "odd",
      type: "x.gone",
      config: { a: 1 },
      branches: { left: [{ id: "inner", type: "flow.stop", config: {} }] },
    });
    const f = focus(d, m, { stepId: "odd" });
    expect(f.nodeLabel).toBe("x.gone");
    expect(f.schema).toBeUndefined();
    expect(f.config).toEqual({ a: 1 });
    expect(f.branches).toEqual([{ id: "left", label: "left", steps: 1 }]);
    expect(f.issues.map((i) => i.code)).toContain("node.unknown");
    const [g] = getSteps(d, m, { ids: ["odd"], include: ["config", "schema", "refs"] }).steps;
    expect(g?.schema).toBeUndefined();
    expect(g?.refs?.length).toBeGreaterThan(0);
    expect(findSteps(d, m, { where: { type: "x.gone" } }).matches[0]?.line).toBe(
      "odd  x.gone · 1 issue",
    );
    expect(describeNodeTypes(d, m, { types: ["x.gone"] })).toEqual({
      types: [],
      unknown: ["x.gone"],
    });
  });

  it("an empty doc through every detail read", () => {
    const d: WorkflowDoc = { ...doc(), steps: [], sections: [] };
    expect(getSteps(d, m, { where: {} })).toEqual({ steps: [], missing: [] });
    expect(getSteps(d, m, { ids: ["a"] })).toEqual({ steps: [], missing: ["a"] });
    expect(findSteps(d, m, { where: {} })).toEqual({ count: 0, matches: [] });
    const issues = getIssues(d, m, {});
    expect(issues.issues.map((i) => i.code)).toEqual(["doc.empty"]);
    expect(issues.warnings).toBe(1);
    expect(() => focus(d, m, { stepId: "a" })).toThrow(FlowlineTreeError);
    expect(() => availableRefs(d, m, { stepId: "a" })).toThrow(FlowlineTreeError);
    expect(listNodeTypes(d, m, {}).types.length).toBe(m.nodes.length);
  });
});

/**
 * Pages a `getSteps` call to the end, as a caller would: follows `next`, and when `next` holds
 * fewer IDs than `remaining`, asks again for the IDs not yet returned. Checks each page's size.
 */
function drain(
  d: WorkflowDoc,
  args: ReadArgs["getSteps"],
): { details: StepDetail[]; calls: number } {
  const details: StepDetail[] = [];
  const wantIds = "ids" in args ? args.ids : undefined;
  let cur: ReadArgs["getSteps"] | undefined = args;
  let calls = 0;
  while (cur) {
    const r = getSteps(d, m, cur);
    calls++;
    const { next, remaining, ...page } = r;
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(page.steps.length > 1 ? 8000 : 1e6);
    expect(JSON.stringify(next ?? {}).length).toBeLessThanOrEqual(450);
    expect(r.steps.length).toBeGreaterThan(0);
    details.push(...r.steps);
    cur = (next as Extract<FollowUp, { tool: "getSteps" }> | undefined)?.args;
    if (!cur && wantIds && details.length < wantIds.length) {
      cur = { ...args, ids: wantIds.slice(details.length) };
    }
  }
  return { details, calls };
}

/** Every step ID of a doc, in pre-order. */
function preorderIds(d: WorkflowDoc): string[] {
  const ids: string[] = [];
  walkSteps(d, (s) => ids.push(s.id));
  return ids;
}

describe("step read budgets", () => {
  it("getSteps with 200 ids and refs stays within budget; paging recovers everything", () => {
    const d = flatDoc(500);
    const ids = preorderIds(d).slice(300);
    const include: ("config" | "refs")[] = ["config", "refs"];
    const { details, calls } = drain(d, { ids, include });
    expect(calls).toBeGreaterThan(1);
    expect(details.map((s) => s.id)).toEqual(ids);
    const refsFollowUps = new Map<string, FollowUp>();
    for (const s of details) {
      expect(s.refs?.length).toBeLessThanOrEqual(30);
      for (const o of s.omitted ?? []) {
        expect(o).toMatchObject({ what: "refs", stepId: s.id });
        refsFollowUps.set(s.id, o.fetch);
      }
    }
    for (const s of details) {
      expect(s.config).toEqual(d.steps.find((x) => x.id === s.id)?.config);
      const all = availableRefs(d, m, { stepId: s.id }).refs;
      const follow = refsFollowUps.get(s.id) as FollowUp;
      expect(follow).toEqual({ tool: "availableRefs", args: { stepId: s.id } });
      const recovered = (
        reads[follow.tool](d, m, follow.args as never) as ReadResults["availableRefs"]
      ).refs;
      expect(recovered).toEqual(all);
      // The shown refs are the trigger and the 29 nearest.
      expect(s.refs).toEqual([...all.slice(0, 1), ...all.slice(-29)]);
      expect(s.omitted?.[0]?.count).toBe(all.length - 30);
    }
  });

  it("the ids form's next carries at most 400 chars of IDs, and is outside the budget", () => {
    const d = flatDoc(500);
    const ids = preorderIds(d);
    const r = getSteps(d, m, { ids, include: ["config"] });
    const { next, remaining, ...page } = r;
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(8000);
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(8000 + 450);
    expect(JSON.stringify(next).length).toBeLessThanOrEqual(450);
    const nextIds = (next as Extract<FollowUp, { tool: "getSteps" }>).args as { ids: string[] };
    expect(JSON.stringify(nextIds.ids).length).toBeLessThanOrEqual(400);
    // The IDs right after this page, in order; `remaining` counts all of the rest.
    expect(nextIds.ids).toEqual(ids.slice(r.steps.length, r.steps.length + nextIds.ids.length));
    expect(nextIds.ids.length).toBeGreaterThan(20);
    expect(remaining).toBe(500 - r.steps.length);
    expect(next).toEqual({ tool: "getSteps", args: { ids: nextIds.ids, include: ["config"] } });
    // A short rest is carried whole.
    const short = getSteps(d, m, { ids: ids.slice(0, 20), include: ["config"], budget: 1000 });
    const shortNext = short.next as Extract<FollowUp, { tool: "getSteps" }>;
    expect((shortNext.args as { ids: string[] }).ids).toEqual(ids.slice(short.steps.length, 20));
    expect(short.remaining).toBe(20 - short.steps.length);
  });

  it("a 12-deep, 500-step heavy doc pages in a few dozen calls, in either form", () => {
    const d = deepDoc(12, 500, { noteChars: 4000, configChars: 20_000 });
    const ids = preorderIds(d);
    const byIds = drain(d, { ids, include: ["config"] });
    expect(byIds.details.map((s) => s.id)).toEqual(ids);
    expect(byIds.calls).toBeLessThanOrEqual(60);
    const byWhere = drain(d, { where: {}, include: ["config"] });
    expect(byWhere.details.map((s) => s.id)).toEqual(ids);
    expect(byWhere.calls).toBeLessThanOrEqual(60);
  });

  it("at least one step comes back, even over budget", () => {
    const r = getSteps(doc(), m, { ids: ["mail", "deal"], full: true, budget: 100 });
    expect(r.steps.map((s) => s.id)).toEqual(["mail"]);
    expect(r.steps[0]?.config?.body).toBe(BODY);
    expect(r.next).toEqual({ tool: "getSteps", args: { ids: ["deal"], full: true, budget: 100 } });
    expect(r.remaining).toBe(1);
  });

  it("the where form resumes with next after the last step that fit", () => {
    const d = flatDoc(60, { noteChars: 4000 });
    const r = getSteps(d, m, { where: {}, include: [], full: true });
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(8000);
    const last = r.steps[r.steps.length - 1]?.id;
    expect(r.next).toEqual({
      tool: "getSteps",
      args: { where: {}, include: [], full: true, after: last },
    });
    expect(r.remaining).toBe(60 - r.steps.length);
  });

  it("focus leaves out refs, then the schema, when over budget", () => {
    const d = flatDoc(500);
    const big = focus(d, m, { stepId: "step_500", budget: 1e6 });
    expect(big.refs).toHaveLength(30);
    expect(big.omitted).toEqual([
      {
        what: "refs",
        stepId: "step_500",
        count: 470,
        fetch: { tool: "availableRefs", args: { stepId: "step_500" } },
      },
    ]);
    const tight = focus(d, m, { stepId: "step_500", budget: 150 });
    expect(tight.refs).toBeUndefined();
    expect(tight.schema).toBeUndefined();
    expect(tight.omitted).toEqual([
      {
        what: "refs",
        stepId: "step_500",
        count: 500,
        fetch: { tool: "availableRefs", args: { stepId: "step_500" } },
      },
      {
        what: "schema",
        stepId: "step_500",
        count: 1,
        fetch: { tool: "describeNodeTypes", args: { types: ["crm.sendEmail"] } },
      },
    ]);
    expect(focus(d, m, { stepId: "step_500" }).schema).toBeDefined();
    expect(JSON.stringify(focus(d, m, { stepId: "step_500" })).length).toBeLessThanOrEqual(8000);
  });
});

describe("step read cost", () => {
  function median(fn: () => unknown): number {
    fn();
    const ts: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      fn();
      ts.push(performance.now() - t);
    }
    return ts.sort((a, b) => a - b)[2] as number;
  }

  it("getSteps with 200 ids and refs is linear in the doc (500 and 2000 steps)", () => {
    const include = ["refs", "issues", "config"] as never;
    const d500 = flatDoc(500);
    const ids500 = preorderIds(d500).slice(300);
    const t500 = median(() => getSteps(d500, m, { ids: ids500, include, budget: 1e9 }));
    const d2k = flatDoc(2000);
    const ids2k = preorderIds(d2k).slice(1800);
    const t2k = median(() => getSteps(d2k, m, { ids: ids2k, include, budget: 1e9 }));
    // Generous CI margins (measured locally: see the task report).
    expect(t500).toBeLessThan(250);
    expect(t2k).toBeLessThan(250);
  });

  it("step reads with 100 sections don't scan sections per step", () => {
    const d = flatDoc(500);
    d.sections = Array.from({ length: 100 }, (_, i) => ({
      id: `s${i}`,
      title: `S${i}`,
      color: "blue" as const,
      first: `step_${i * 5 + 1}`,
      last: `step_${i * 5 + 5}`,
    }));
    const ids = preorderIds(d).slice(300);
    expect(median(() => getSteps(d, m, { ids, budget: 1e9 }))).toBeLessThan(250);
    const [s] = getSteps(d, m, { ids: ["step_498"] }).steps;
    expect(s?.section?.id).toBe("s99");
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
