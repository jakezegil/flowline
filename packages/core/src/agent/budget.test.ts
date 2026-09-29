import { describe, expect, it } from "vitest";
import { walkSteps } from "../tree";
import type { Manifest, Step, WorkflowDoc } from "../types";
import { crmLikeManifest, deepDoc, flatDoc } from "./fixtures";
import { resultSize } from "./format";
import { outline, overview } from "./outline";
import type { FollowUp, Omission, OutlineResult, ReadResults, StepDetail } from "./read-types";
import { reads } from "./reads";

const m = crmLikeManifest();

function allIds(doc: WorkflowDoc): Set<string> {
  const ids = new Set<string>();
  walkSteps(doc, (s) => ids.add(s.id));
  return ids;
}

/** Step IDs shown in a result's text: the first token of each line, when it is a step ID. */
function shownIds(r: OutlineResult, ids: Set<string>): string[] {
  const out: string[] = [];
  for (const line of r.text.split("\n")) {
    const token = line.replace(/^[\s│]+/, "").split(" ")[0] ?? "";
    if (ids.has(token)) out.push(token);
  }
  return out;
}

/**
 * Each doc, with what a 600 budget drops: the omission kinds (with branch or tail anchors) and
 * the step IDs still shown.
 */
const cases: [string, () => WorkflowDoc, string[], string[]][] = [
  ["5 flat", () => flatDoc(5), [], ["step_1", "step_2", "step_3", "step_4", "step_5"]],
  [
    "50 flat",
    () => flatDoc(50),
    ["config", "steps after step_5"],
    ["step_1", "step_2", "step_3", "step_4", "step_5"],
  ],
  [
    "500 flat",
    () => flatDoc(500),
    ["config", "steps after step_5"],
    ["step_1", "step_2", "step_3", "step_4", "step_5"],
  ],
  ["12-deep", () => deepDoc(12), ["config", "branch if_1/then"], ["if_1", "stop_1"]],
  ["12-deep, 50 steps", () => deepDoc(12, 50), ["config", "branch if_1/then"], ["if_1", "stop_1"]],
  [
    "12-deep, 500 steps",
    () => deepDoc(12, 500),
    ["config", "branch if_1/then"],
    ["if_1", "stop_1"],
  ],
  // With 4000-char notes, the note, config and tail omissions of even one step overflow 600.
  [
    "500 flat, 4000-char notes, 20k config",
    () => flatDoc(500, { noteChars: 4000, configChars: 20_000 }),
    ["steps"],
    [],
  ],
  [
    "12-deep, 500 steps, 4000-char notes",
    () => deepDoc(12, 500, { noteChars: 4000, configChars: 20_000 }),
    ["steps"],
    [],
  ],
];

/** An omission as a short label: `config`, `branch if_1/then`, `steps after step_5`. */
function kind(o: Omission): string {
  if (o.what === "branch") return `branch ${o.stepId}/${o.branch}`;
  if (o.what === "steps" && o.fetch.tool === "outline" && o.fetch.args.after !== undefined) {
    return `steps after ${o.fetch.args.after}`;
  }
  return o.what;
}

describe("budget", () => {
  it.each(cases)("%s: overview stays within 4000 chars", (_, make) => {
    const r = overview(make(), m, {});
    expect(resultSize(r)).toBeLessThanOrEqual(4000);
  });

  it.each(cases)("%s: a 600 budget drops the expected content", (_, make, kinds, shown) => {
    const doc = make();
    const r = overview(doc, m, { budget: 600 });
    expect(resultSize(r)).toBeLessThanOrEqual(600);
    expect(r.omitted.map(kind)).toEqual(kinds);
    expect(shownIds(r, allIds(doc))).toEqual(shown);
  });

  it("heavy docs show steps once the budget allows one", () => {
    const doc = flatDoc(500, { noteChars: 4000, configChars: 20_000 });
    const r = overview(doc, m, { budget: 1000 });
    expect(resultSize(r)).toBeLessThanOrEqual(1000);
    expect(shownIds(r, allIds(doc)).length).toBeGreaterThan(0);
    expect(r.text).toContain(`: note "${"n1 ".padEnd(40, "x")}…(+4k chars)"`);
  });

  it("a 5-step flat doc needs one read", () => {
    const r = overview(flatDoc(5), m, {});
    expect(r.omitted).toEqual([]);
    expect(r.text.match(/ {4}config /g)).toHaveLength(5);
  });

  it("500 flat: paging with after returns every step exactly once", () => {
    const doc = flatDoc(500);
    const ids = allIds(doc);
    const seen: string[] = [];
    let r = overview(doc, m, {});
    let pages = 1;
    for (;;) {
      expect(resultSize(r)).toBeLessThanOrEqual(4000);
      seen.push(...shownIds(r, ids));
      const tails = r.omitted.filter((o) => o.what === "steps");
      expect(tails.length).toBeLessThanOrEqual(1);
      const tail = tails[0];
      if (!tail) break;
      expect(tail.fetch.tool).toBe("outline");
      r = outline(doc, m, tail.fetch.args as { after: string });
      pages++;
    }
    expect(pages).toBeGreaterThan(1);
    expect(seen).toHaveLength(500);
    expect(new Set(seen)).toEqual(ids);
  });

  it.each([
    ["12-deep, overview budget 800", () => deepDoc(12), 800],
    ["12-deep, 50 steps, overview budget 1200", () => deepDoc(12, 50), 1200],
    ["12-deep, 500 steps", () => deepDoc(12, 500), 4000],
    ["12-deep, 500 steps, 4000-char notes", () => deepDoc(12, 500, { noteChars: 4000 }), 4000],
  ] as [string, () => WorkflowDoc, number][])(
    "%s: every follow-up returns the hidden steps",
    (_, make, budget) => {
      const doc = make();
      const ids = allIds(doc);
      const seen = new Set<string>();
      const first = overview(doc, m, { budget });
      expect(resultSize(first)).toBeLessThanOrEqual(budget);
      const queue: OutlineResult[] = [first];
      let branchFollowUps = 0;
      while (queue.length > 0) {
        const r = queue.shift() as OutlineResult;
        expect(resultSize(r)).toBeLessThanOrEqual(4000);
        for (const id of shownIds(r, ids)) seen.add(id);
        for (const o of r.omitted) {
          if (o.fetch.tool !== "outline") continue;
          const next = outline(doc, m, o.fetch.args);
          if (o.what === "branch") {
            branchFollowUps++;
            const { stepId, branch } = o.fetch.args;
            const parent = findIn(doc.steps, stepId as string);
            const direct = (parent?.branches?.[branch as string] ?? []).map((s) => s.id);
            const shown = shownIds(next, ids);
            const pagedOn = next.omitted.some((x) => x.what === "steps");
            // The branch's own steps come back (all of them, or a first page).
            expect(direct.length).toBeGreaterThan(0);
            if (pagedOn) expect(shown).toContain(direct[0]);
            else for (const id of direct) expect(shown).toContain(id);
          }
          queue.push(next);
        }
      }
      expect(branchFollowUps).toBeGreaterThan(0);
      expect(seen).toEqual(ids);
    },
  );

  it("below the floor returns exactly the floor", () => {
    for (const doc of [flatDoc(500), deepDoc(12)]) {
      const r = overview(doc, m, { budget: 50 });
      const lines = r.text.split("\n");
      expect(lines).toHaveLength(4);
      expect(lines[0]).toBe(`workflow ${JSON.stringify(doc.name)}`);
      expect(lines[1]).toBe("trigger  Deal stuck in stage (poll, every 10s)");
      expect(lines[2]).toMatch(/^… \d+ steps: outline\(\{\}\)$/);
      expect(lines[3]).toMatch(/^— /);
      expect(r.omitted).toHaveLength(1);
      expect(r.omitted[0]?.what).toBe("steps");
    }
  });

  it("at the floor the result fits exactly", () => {
    const doc = flatDoc(500);
    const floor = overview(doc, m, { budget: 0 });
    const r = overview(doc, m, { budget: resultSize(floor) });
    expect(r).toEqual(floor);
    expect(resultSize(r)).toBe(resultSize(floor));
  });

  it("drops config first, then shortens notes", () => {
    const doc = flatDoc(120);
    const r = overview(doc, m, {});
    expect(r.omitted[0]).toEqual({
      what: "config",
      count: expect.any(Number),
      fetch: { tool: "getSteps", args: { where: {}, include: ["config"], limit: 50 } },
    });
    expect(r.text).toContain('(config left out: getSteps({where:{},include:["config"],limit:50}))');
    // Notes are still whole: nothing was cut.
    expect(r.text).toContain(': note "Note on step 1"');
    expect(r.omitted.some((o) => o.what === "notes")).toBe(false);
  });

  it("shortens notes to 40 once config alone isn't enough", () => {
    const doc = flatDoc(12, { noteChars: 100 });
    const full = overview(doc, m, { budget: 1_000_000 });
    const noConfig = overview(doc, m, { budget: resultSize(full) - 1 });
    // Notes of 100 chars are whole at 120.
    expect(noConfig.text).toContain(`note "${"n1 ".padEnd(100, "x")}"`);
    const r = overview(doc, m, { budget: resultSize(noConfig) - 1 });
    expect(resultSize(r)).toBeLessThanOrEqual(resultSize(noConfig) - 1);
    expect(r.text).toContain(`note "${"n1 ".padEnd(40, "x")}…(+60 chars)"`);
    expect(r.omitted.map((o) => o.what)).toEqual(["config", "notes"]);
    expect(r.omitted[1]?.fetch).toEqual({
      tool: "getSteps",
      args: { ids: doc.steps.map((s) => s.id), include: [], full: true },
    });
  });

  it("the notes follow-up is a selector when the IDs would take over 400 chars", () => {
    const doc = flatDoc(60, { noteChars: 200 });
    const r = overview(doc, m, { budget: 20_000 });
    const notes = r.omitted.find((o) => o.what === "notes");
    expect(notes?.count).toBe(60);
    expect(notes?.fetch).toEqual({
      tool: "getSteps",
      args: { where: {}, include: [], full: true, limit: 50 },
    });
  });

  it("an empty doc below the floor returns header and totals", () => {
    const doc: WorkflowDoc = { ...flatDoc(0) };
    const r = overview(doc, m, { budget: 10 });
    expect(r.text.split("\n")).toEqual([
      'workflow "Flat"',
      "trigger  Deal stuck in stage (poll, every 10s)",
      "— 0 steps · 0 sections · 0 notes · 0 errors · 1 warning",
    ]);
    expect(r.omitted).toEqual([]);
  });

  it.each([1, 30])(
    "an empty doc with %i orphaned broken sections fits just above the floor",
    (n) => {
      const sections = Array.from({ length: n }, (_, i) => ({
        id: `gone_${i}`,
        title: `Gone ${i}`,
        color: "blue" as const,
        first: `x_${i}`,
        last: `y_${i}`,
      }));
      const doc: WorkflowDoc = { ...flatDoc(0), sections };
      const floor = overview(doc, m, { budget: 0 });
      expect(floor.text).not.toContain("▣");
      for (const extra of [0, 1, 10, 80, 200]) {
        const budget = resultSize(floor) + extra;
        const r = overview(doc, m, { budget });
        expect(resultSize(r)).toBeLessThanOrEqual(budget);
        expect(r.totals.sections).toBe(n);
      }
      // With room, they are shown, or folded into one line with a getIssues follow-up.
      const roomy = overview(doc, m, { budget: resultSize(floor) + 200 });
      if (n === 1) expect(roomy.text).toContain('▣ section gone_0 "Gone 0" [blue] (broken)');
      else {
        expect(roomy.text).toContain("⚠ 30 sections reference missing steps: getIssues({})");
        expect(roomy.omitted).toEqual([
          { what: "sections", count: 30, fetch: { tool: "getIssues", args: {} } },
        ]);
      }
    },
  );

  it("collapses the deepest branch first", () => {
    const doc = deepDoc(12);
    const full = overview(doc, m, { budget: 1_000_000 });
    const noConfig = overview(doc, m, { budget: resultSize(full) - 1 });
    const r = overview(doc, m, { budget: resultSize(noConfig) - 1 });
    const branches = r.omitted.filter((o) => o.what === "branch");
    expect(branches.length).toBeGreaterThan(0);
    // if_12's one-step branches cost more as markers than they save; if_11's `then` is next.
    expect(branches.map((o) => [o.stepId, o.branch])).toEqual([["if_11", "then"]]);
    expect(r.text).toContain('├ … 4 steps in branch then: outline({stepId:"if_11",branch:"then"})');
  });

  it("marks cut notes with a full: true follow-up, even when cut to 40", () => {
    const doc = flatDoc(50, { noteChars: 300 });
    const r = overview(doc, m, {});
    expect(r.text).toContain(`note "${"n1 ".padEnd(40, "x")}…(+260 chars)"`);
    expect(r.text).not.toContain(`note "${"n1 ".padEnd(41, "x")}`);
    const notes = r.omitted.find((o) => o.what === "notes");
    expect(notes?.fetch.tool).toBe("getSteps");
    expect((notes?.fetch.args as { full?: boolean } | undefined)?.full).toBe(true);
  });
});

function run(doc: WorkflowDoc, f: FollowUp): unknown {
  return reads[f.tool](doc, m, f.args as never);
}

/**
 * Runs a `getSteps` follow-up and every page after it (its `next`, or the `omitted` steps left
 * out by the size budget); the details of each page, in order.
 */
function pages(doc: WorkflowDoc, f: FollowUp): StepDetail[] {
  const out: StepDetail[] = [];
  let cur: FollowUp | undefined = f;
  while (cur) {
    expect(cur.tool).toBe("getSteps");
    const r = run(doc, cur) as ReadResults["getSteps"];
    expect(r.missing).toEqual([]);
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(8000);
    out.push(...r.steps);
    cur = r.next ?? r.omitted?.find((o) => o.what === "steps")?.fetch;
  }
  return out;
}

function stepsById(doc: WorkflowDoc): Map<string, Step> {
  const byId = new Map<string, Step>();
  walkSteps(doc, (s) => byId.set(s.id, s));
  return byId;
}

describe("budget follow-ups return the omitted content", () => {
  it.each([
    ["500 flat", () => flatDoc(500, { noteChars: 4000, configChars: 20_000 })],
    ["12-deep, 500 steps", () => deepDoc(12, 500, { noteChars: 4000, configChars: 20_000 })],
  ] as [string, () => WorkflowDoc][])(
    "%s, 4000-char notes, 20k config: executing every omission returns every step uncut",
    (_, make) => {
      const doc = make();
      const ids = allIds(doc);
      const seen = new Set<string>();
      const details: StepDetail[] = [];
      const done = new Set<string>();
      const queue: FollowUp[] = [];
      const push = (f: FollowUp | undefined) => {
        if (!f) return;
        const key = JSON.stringify(f);
        if (done.has(key)) return;
        done.add(key);
        queue.push(f);
      };
      const first = overview(doc, m, {});
      expect(resultSize(first)).toBeLessThanOrEqual(4000);
      for (const o of first.omitted) push(o.fetch);
      expect(queue.length).toBeGreaterThan(0);
      while (queue.length > 0) {
        const f = queue.shift() as FollowUp;
        const result = run(doc, f);
        if (f.tool === "outline") {
          const r = result as OutlineResult;
          expect(resultSize(r)).toBeLessThanOrEqual(4000);
          for (const id of shownIds(r, ids)) seen.add(id);
          for (const o of r.omitted) push(o.fetch);
        } else if (f.tool === "getSteps") {
          const r = result as ReadResults["getSteps"];
          expect(r.missing).toEqual([]);
          for (const s of r.steps) {
            seen.add(s.id);
            details.push(s);
          }
          push(r.next);
          push(r.full);
          for (const o of r.omitted ?? []) push(o.fetch);
        }
      }
      expect(seen).toEqual(ids);
      for (const [id, step] of stepsById(doc)) {
        const mine = details.filter((d) => d.id === id);
        const configs = mine.filter((d) => d.config !== undefined).map((d) => d.config);
        expect(configs).toContainEqual(step.config);
        expect(mine.map((d) => d.note)).toContain(step.note);
      }
      expect(details.some((d) => d.config?.dealId === "y".repeat(20_000))).toBe(true);
    },
    // Some hundreds of 1-step pages: 4000-char notes leave room for one step per 8000 budget.
    30_000,
  );

  it("config, where form: pages return every step's config", () => {
    const doc = flatDoc(120);
    const o = overview(doc, m, {}).omitted.find((x) => x.what === "config");
    expect(o?.fetch).toEqual({
      tool: "getSteps",
      args: { where: {}, include: ["config"], limit: 50 },
    });
    const got = pages(doc, o?.fetch as FollowUp);
    expect(got.map((d) => d.id)).toEqual([...allIds(doc)]);
    const byId = stepsById(doc);
    for (const d of got) expect(d.config).toEqual(byId.get(d.id)?.config);
  });

  it("config of a subtree outline, by IDs and in the split form, includes the root step", () => {
    const byId = stepsById(deepDoc(12, 500));
    const forms = new Set<string>();
    for (const [make, stepId, budget] of [
      [() => deepDoc(4, 40), "if_3", 1500],
      [() => deepDoc(12, 500), "if_1", 4000],
    ] as [() => WorkflowDoc, string, number][]) {
      const doc = make();
      const r = outline(doc, m, { stepId, budget });
      const configs = r.omitted.filter((x) => x.what === "config");
      expect(configs.length).toBeGreaterThan(0);
      const got = new Map<string, StepDetail>();
      for (const c of configs) {
        const args = c.fetch.args as { ids?: string[] };
        forms.add(args.ids ? (args.ids.length === 1 ? "root" : "ids") : "where");
        for (const d of pages(doc, c.fetch)) got.set(d.id, d);
      }
      // The subtree root is among them, and every returned step has its config.
      expect(got.has(stepId)).toBe(true);
      const total = configs.reduce((n, c) => n + c.count, 0);
      expect(got.size).toBeGreaterThanOrEqual(total);
      for (const d of got.values()) {
        expect(d.config).toEqual(stepsById(doc).get(d.id)?.config ?? byId.get(d.id)?.config);
      }
    }
    expect(forms).toEqual(new Set(["ids", "root", "where"]));
  });

  it("notes, IDs form: full: true returns step notes, names, and the section note and title", () => {
    const doc = flatDoc(12, { noteChars: 300 });
    (doc.steps[1] as Step).name = "N".repeat(150);
    doc.sections = [
      {
        id: "intro",
        title: "T".repeat(200),
        color: "green",
        note: "S".repeat(900),
        first: "step_1",
        last: "step_3",
      },
    ];
    const o = overview(doc, m, {}).omitted.find((x) => x.what === "notes");
    expect(o?.fetch).toMatchObject({ tool: "getSteps", args: { include: [], full: true } });
    const fetch = o?.fetch as FollowUp;
    expect((fetch.args as { ids?: string[] }).ids).toContain("step_1");
    const got = pages(doc, fetch);
    const byId = stepsById(doc);
    for (const d of got) {
      expect(d.note).toBe(byId.get(d.id)?.note);
      expect(d.cut).toBeUndefined();
    }
    const s1 = got.find((d) => d.id === "step_1");
    expect(s1?.section).toEqual({
      id: "intro",
      title: "T".repeat(200),
      color: "green",
      note: "S".repeat(900),
    });
    expect(got.find((d) => d.id === "step_2")?.name).toBe("N".repeat(150));
  });

  it("notes, where form: pages return every note whole", () => {
    const doc = flatDoc(60, { noteChars: 200 });
    const o = overview(doc, m, { budget: 20_000 }).omitted.find((x) => x.what === "notes");
    expect(o?.fetch).toEqual({
      tool: "getSteps",
      args: { where: {}, include: [], full: true, limit: 50 },
    });
    const got = pages(doc, o?.fetch as FollowUp);
    expect(got).toHaveLength(60);
    const byId = stepsById(doc);
    for (const d of got) expect(d.note).toBe(byId.get(d.id)?.note);
  });

  it("branch labels cut in the outline come back whole on the owning step", () => {
    const long = "L".repeat(150);
    const doc: WorkflowDoc = {
      ...flatDoc(0),
      steps: [
        {
          id: "sw",
          type: "flow.if",
          config: { value: true },
          branches: { else: [{ id: "s1", type: "flow.stop", config: {} }] },
        },
      ],
    };
    const labelled: Manifest = {
      ...m,
      nodes: m.nodes.map((n) =>
        n.type === "flow.if"
          ? { ...n, branches: { kind: "static", branches: [{ id: "else", label: long }] } }
          : n,
      ),
    };
    const o = overview(doc, labelled, {}).omitted.find((x) => x.what === "notes");
    expect(o?.fetch).toEqual({ tool: "getSteps", args: { ids: ["sw"], include: [], full: true } });
    const f = o?.fetch as Extract<FollowUp, { tool: "getSteps" }>;
    const [d] = reads.getSteps(doc, labelled, f.args).steps;
    expect(d?.branches).toEqual([{ id: "else", label: long, steps: 1 }]);
  });

  it("sections: the orphan fold's follow-up returns their issues", () => {
    const doc: WorkflowDoc = {
      ...flatDoc(0),
      sections: Array.from({ length: 30 }, (_, i) => ({
        id: `gone_${i}`,
        title: `Gone ${i}`,
        color: "blue" as const,
        first: `x_${i}`,
        last: `y_${i}`,
      })),
    };
    const floor = resultSize(overview(doc, m, { budget: 0 }));
    const fold = overview(doc, m, { budget: floor + 200 }).omitted.find(
      (o) => o.what === "sections",
    );
    expect(fold?.fetch).toEqual({ tool: "getIssues", args: {} });
    const r = run(doc, fold?.fetch as FollowUp) as ReadResults["getIssues"];
    const ids = new Set(r.issues.map((i) => i.sectionId).filter((x) => x !== undefined));
    expect(ids.size).toBe(30);
  });

  it.each([
    ["branch", "12-deep", () => deepDoc(12)],
    ["branch", "12-deep, 200 steps", () => deepDoc(12, 200)],
    ["steps", "60 flat", () => flatDoc(60)],
  ] as ["branch" | "steps", string, () => WorkflowDoc][])(
    "%s omissions (%s): each follow-up, followed to the end, shows exactly the steps it counts",
    (kind, _, make) => {
      const doc = make();
      const ids = allIds(doc);
      const r = overview(doc, m, { budget: 800 });
      const hidden = (o: Omission) => o.what === "branch" || o.what === "steps";
      // Every step shown by an omission's follow-up and, in turn, by theirs.
      const reach = (o: Omission, out: Set<string>): Set<string> => {
        const next = run(doc, o.fetch) as OutlineResult;
        expect(resultSize(next)).toBeLessThanOrEqual(4000);
        for (const id of shownIds(next, ids)) out.add(id);
        for (const x of next.omitted.filter(hidden)) reach(x, out);
        return out;
      };
      const of = r.omitted.filter((o) => o.what === kind);
      expect(of.length).toBeGreaterThan(0);
      for (const o of of) {
        const got = reach(o, new Set());
        // A branch outline also shows its owning step, and a tail outline its anchor: not counted.
        if (o.fetch.tool === "outline" && o.fetch.args.stepId !== undefined) {
          got.delete(o.fetch.args.stepId);
        }
        if (o.fetch.tool === "outline" && o.fetch.args.after !== undefined) {
          got.delete(o.fetch.args.after);
        }
        expect(got.size, JSON.stringify(o.fetch.args)).toBe(o.count);
      }
    },
  );
});

function findIn(steps: Step[], id: string): Step | undefined {
  for (const s of steps) {
    if (s.id === id) return s;
    for (const list of Object.values(s.branches ?? {})) {
      const f = findIn(list, id);
      if (f) return f;
    }
  }
  return undefined;
}
