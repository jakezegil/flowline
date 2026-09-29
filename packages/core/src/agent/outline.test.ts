import { describe, expect, it } from "vitest";
import type { Step, WorkflowDoc } from "../types";
import { crmLikeManifest, specExampleDoc } from "./fixtures";
import { cutString, formatCall, resultSize, stepLine } from "./format";
import { outline, overview } from "./outline";
import type { OutlineResult } from "./read-types";

const m = crmLikeManifest();
const node = (type: string) => m.nodes.find((n) => n.type === type);
const collapse = (line: string) => line.replace(/\s+/g, " ").trim();

/** The spec §3 example, illustrative in its spacing. */
const SPEC_EXAMPLE = `trigger  Deal stuck in stage (poll, every 10s)
▣ section check "Check the deal" [blue]: note "Skip if the deal already moved"
  getDeal        Get deal
  recheck        If  · 1 issue
    ├ then
    │  notifyOwner  Send email: note "Owner, not assignee"
    └ else
       stopMoved    Stop
delay_1m       Delay`;

/** The smallest budget whose result drops config and nothing else. */
function configOnlyBudget(doc: WorkflowDoc): number {
  const full = overview(doc, m, { budget: 1_000_000 });
  expect(full.omitted).toEqual([]);
  // Every budget from the no-config size up to the full size gives the same no-config result.
  const b = resultSize(overview(doc, m, { budget: resultSize(full) - 1 }));
  expect(overview(doc, m, { budget: b }).omitted.map((o) => o.what)).toEqual(["config"]);
  expect(overview(doc, m, { budget: b - 1 }).omitted.map((o) => o.what)).not.toEqual(["config"]);
  return b;
}

describe("format helpers", () => {
  it("cutString cuts with a size marker", () => {
    expect(cutString("abc", 5)).toEqual({ text: "abc", cut: false });
    expect(cutString("a".repeat(300), 120)).toEqual({
      text: `${"a".repeat(120)}…(+180 chars)`,
      cut: true,
    });
    expect(cutString("a".repeat(20_000), 500).text).toBe(`${"a".repeat(500)}…(+19.5k chars)`);
    expect(cutString("a".repeat(1500), 300).text.endsWith("…(+1.2k chars)")).toBe(true);
  });

  it("stepLine renders name, colour, issues and note in order", () => {
    const s: Step = {
      id: "getDeal",
      type: "crm.getDeal",
      config: {},
      name: "Load it",
      color: "pink",
      note: "Check the owner",
    };
    expect(stepLine(s, node("crm.getDeal"), 1, 120)).toBe(
      'getDeal  Get deal “Load it” [pink] · 1 issue: note "Check the owner"',
    );
    expect(stepLine({ id: "x", type: "a.b", config: {} }, undefined, 2, 120)).toBe(
      "x  a.b · 2 issues",
    );
    expect(
      stepLine({ ...s, color: "red" as never, name: undefined }, node("crm.getDeal"), 0, 5),
    ).toBe('getDeal  Get deal [gray]: note "Check…(+10 chars)"');
  });

  it("formatCall prints a compact call", () => {
    expect(formatCall({ tool: "outline", args: { stepId: "recheck", branch: "else" } })).toBe(
      'outline({stepId:"recheck",branch:"else"})',
    );
    expect(
      formatCall({ tool: "getSteps", args: { where: {}, include: ["config"], limit: 50 } }),
    ).toBe('getSteps({where:{},include:["config"],limit:50})');
    expect(formatCall({ tool: "overview", args: {} })).toBe("overview({})");
  });

  it("resultSize counts text and serialized omissions", () => {
    const r: Pick<OutlineResult, "text" | "omitted"> = { text: "abc", omitted: [] };
    expect(resultSize(r)).toBe(5);
  });
});

describe("overview: the spec §3 example", () => {
  it("pins the rule-based output at the config-only budget", () => {
    const doc = specExampleDoc();
    const B = configOnlyBudget(doc);
    const r = overview(doc, m, { budget: B });
    expect(resultSize(r)).toBeLessThanOrEqual(B);
    expect(r.omitted).toEqual([
      {
        what: "config",
        count: 3,
        fetch: { tool: "getSteps", args: { where: {}, include: ["config"], limit: 50 } },
      },
    ]);
    expect(r.text).toMatchInlineSnapshot(`
      "trigger  Deal stuck in stage (poll, every 10s)
      ▣ section check "Check the deal" [blue]: note "Skip if the deal already moved"
        getDeal   Get deal
        recheck   If · 1 issue
          ├ then
          │  notifyOwner  Send email: note "Owner, not assignee"
          └ else
             stopMoved  Stop
      delay_1m  Delay
      (config left out: getSteps({where:{},include:["config"],limit:50}))
      — 5 steps · 1 section · 2 notes · 1 error · 0 warnings"
    `);
    expect(r.totals).toEqual({ steps: 5, sections: 1, notes: 2, errors: 1, warnings: 0 });
  });

  it("contains each spec line, whitespace collapsed, in order", () => {
    const doc = specExampleDoc();
    const r = overview(doc, m, { budget: configOnlyBudget(doc) });
    const out = r.text.split("\n").map(collapse);
    let at = 0;
    for (const want of SPEC_EXAMPLE.split("\n").map(collapse)) {
      const found = out.indexOf(want, at);
      expect(found, `line ${JSON.stringify(want)} in\n${r.text}`).toBeGreaterThanOrEqual(0);
      at = found + 1;
    }
  });

  it("includes config under a large budget", () => {
    const r = overview(specExampleDoc(), m, {});
    expect(r.omitted).toEqual([]);
    expect(r.text).toMatch(
      /\n {2}getDeal +Get deal\n {6}config \{"dealId":\{"\$ref":"trigger\.deal\.id"\}\}\n/,
    );
    expect(r.text.split("\n").at(-1)).toBe(
      "— 5 steps · 1 section · 2 notes · 1 error · 0 warnings",
    );
  });
});

describe("overview: small docs", () => {
  const five = (): WorkflowDoc => ({
    id: "five",
    name: "Five",
    trigger: { type: "crm.dealStuckInStage", config: { stage: "proposal" } },
    steps: [1, 2, 3, 4, 5].map((n) => ({
      id: `s${n}`,
      type: "crm.getDeal",
      config: { dealId: `deal_${n}` },
    })),
  });

  it("a 5-step doc comes back whole in one read", () => {
    const r = overview(five(), m, {});
    expect(r.omitted).toEqual([]);
    for (const n of [1, 2, 3, 4, 5]) expect(r.text).toContain(`config {"dealId":"deal_${n}"}`);
  });

  it("renders an unknown section colour as gray", () => {
    const doc = {
      ...five(),
      sections: [{ id: "a", title: "A", color: "red" as never, first: "s1", last: "s2" }],
    };
    expect(overview(doc, m, {}).text).toContain('▣ section a "A" [gray]');
  });

  it("renders a broken section as (broken) without members", () => {
    const doc: WorkflowDoc = {
      ...five(),
      sections: [
        { id: "gone", title: "Gone", color: "blue", first: "nope", last: "s2" },
        { id: "rev", title: "Reversed", color: "yellow", first: "s4", last: "s3" },
      ],
    };
    const r = overview(doc, m, {});
    expect(r.text).toContain('▣ section gone "Gone" [blue] (broken)');
    expect(r.text).toContain('▣ section rev "Reversed" [yellow] (broken)');
    // Members are not nested under a broken section.
    expect(r.text).toMatch(/\ns4 {2}Get deal/);
  });

  it("reads hand-edited docs: overlaps, split sections, a 5000-char note", () => {
    const doc = five();
    (doc.steps[0] as Step).note = "x".repeat(5000);
    doc.sections = [
      { id: "a", title: "A", color: "blue", first: "s1", last: "s3" },
      { id: "b", title: "B", color: "pink", first: "s2", last: "s4" },
    ];
    const r = overview(doc, m, {});
    expect(r.text).toContain('▣ section a "A" [blue]');
    expect(r.text).toContain('▣ section b "B" [pink] (overlaps a)');
    expect(r.totals.sections).toBe(2);
    expect(r.omitted.map((o) => o.what)).toEqual(["notes"]);
    for (const sections of [undefined, []]) {
      expect(() => overview({ ...five(), sections }, m, {})).not.toThrow();
    }
  });

  it("cuts a 300-char note to 120 and lists it with a full: true follow-up", () => {
    const doc = five();
    (doc.steps[1] as Step).note = "n".repeat(300);
    const r = overview(doc, m, {});
    expect(r.text).toContain(`note "${"n".repeat(120)}…(+180 chars)"`);
    expect(r.omitted).toEqual([
      {
        what: "notes",
        count: 1,
        fetch: { tool: "getSteps", args: { ids: ["s2"], include: [], full: true } },
      },
    ]);
  });

  it("an empty doc renders header and totals", () => {
    const r = overview({ ...five(), steps: [] }, m, {});
    expect(r.text).toBe(
      "trigger  Deal stuck in stage (poll, every 10s)\n— 0 steps · 0 sections · 0 notes · 0 errors · 1 warning",
    );
  });
});

describe("outline", () => {
  it("renders one branch", () => {
    const r = outline(specExampleDoc(), m, { stepId: "recheck", branch: "then" });
    const lines = r.text.split("\n");
    expect(lines[0]).toBe('outline({stepId:"recheck",branch:"then"})');
    expect(lines[1]).toBe('notifyOwner  Send email: note "Owner, not assignee"');
    expect(r.totals).toEqual({ steps: 1, sections: 0, notes: 1, errors: 0, warnings: 0 });
  });

  it("renders one step's subtree", () => {
    const r = outline(specExampleDoc(), m, { stepId: "recheck" });
    expect(r.text).toContain("recheck  If · 1 issue");
    expect(r.text).toContain("├ then");
    expect(r.text).toContain("stopMoved  Stop");
    expect(r.totals.steps).toBe(3);
  });

  it("pages the top-level list with after", () => {
    const r = outline(specExampleDoc(), m, { after: "recheck" });
    expect(r.text).toContain("delay_1m  Delay");
    expect(r.text).not.toContain("getDeal");
  });

  it("config fetch for a branch is scoped with within", () => {
    const doc = specExampleDoc();
    const notify = (doc.steps[1] as Step).branches?.then?.[0] as Step;
    notify.config.body = "b".repeat(400);
    const full = outline(doc, m, { stepId: "recheck", branch: "then" });
    const r = outline(doc, m, { stepId: "recheck", branch: "then", budget: resultSize(full) - 1 });
    expect(r.omitted[0]).toEqual({
      what: "config",
      count: 1,
      fetch: {
        tool: "getSteps",
        args: {
          where: { within: { stepId: "recheck", branch: "then" } },
          include: ["config"],
          limit: 50,
        },
      },
    });
  });

  it("throws on an unknown step or branch", () => {
    expect(() => outline(specExampleDoc(), m, { stepId: "nope" })).toThrow(/nope/);
    expect(() => outline(specExampleDoc(), m, { stepId: "recheck", branch: "maybe" })).toThrow(
      /maybe/,
    );
  });
});
