import { describe, expect, it } from "vitest";
import { walkSteps } from "../tree";
import type { Step, WorkflowDoc } from "../types";
import { crmLikeManifest, deepDoc, flatDoc } from "./fixtures";
import { resultSize } from "./format";
import { outline, overview } from "./outline";
import type { OutlineResult } from "./read-types";

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

const cases: [string, () => WorkflowDoc][] = [
  ["5 flat", () => flatDoc(5)],
  ["50 flat", () => flatDoc(50)],
  ["500 flat", () => flatDoc(500)],
  ["12-deep", () => deepDoc(12)],
  ["12-deep, 50 steps", () => deepDoc(12, 50)],
  ["12-deep, 500 steps", () => deepDoc(12, 500)],
  [
    "500 flat, 4000-char notes, 20k config",
    () => flatDoc(500, { noteChars: 4000, configChars: 20_000 }),
  ],
  [
    "12-deep, 500 steps, 4000-char notes",
    () => deepDoc(12, 500, { noteChars: 4000, configChars: 20_000 }),
  ],
];

describe("budget", () => {
  it.each(cases)("%s: overview stays within 4000 chars", (_, make) => {
    const r = overview(make(), m, {});
    expect(resultSize(r)).toBeLessThanOrEqual(4000);
  });

  it.each(cases)("%s: overview stays within a 600 budget", (_, make) => {
    const r = overview(make(), m, { budget: 600 });
    expect(resultSize(r)).toBeLessThanOrEqual(600);
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
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe("trigger  Deal stuck in stage (poll, every 10s)");
      expect(lines[1]).toMatch(/^… \d+ steps: outline\(\{\}\)$/);
      expect(lines[2]).toMatch(/^— /);
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
  });

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
    const notes = r.omitted.find((o) => o.what === "notes");
    expect(notes?.fetch.tool).toBe("getSteps");
    expect((notes?.fetch.args as { full?: boolean } | undefined)?.full).toBe(true);
  });
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
