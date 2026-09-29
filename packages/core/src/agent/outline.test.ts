import { describe, expect, it } from "vitest";
import { FlowlineTreeError } from "../tree";
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

  it("stepLine marks a disabled step", () => {
    const s: Step = { id: "a", type: "crm.getDeal", config: {}, disabled: true, name: "Load" };
    expect(stepLine(s, node("crm.getDeal"), 0, 120)).toBe("a  Get deal (disabled) “Load”");
    expect(stepLine({ ...s, disabled: false }, node("crm.getDeal"), 0, 120)).toBe(
      "a  Get deal “Load”",
    );
  });

  it("stepLine escapes a closing quote and backslash in a name", () => {
    const s: Step = { id: "a", type: "crm.getDeal", config: {}, name: "He said ”hi” \\ there" };
    expect(stepLine(s, node("crm.getDeal"), 0, 120)).toBe(
      "a  Get deal “He said \\”hi\\” \\\\ there”",
    );
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
      "workflow "Deal stuck in stage"
      trigger  Deal stuck in stage (poll, every 10s)
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
      'workflow "Five"\ntrigger  Deal stuck in stage (poll, every 10s)\n— 0 steps · 0 sections · 0 notes · 0 errors · 1 warning',
    );
  });

  it("shows the workflow name, escaped, on the first line", () => {
    const r = overview({ ...five(), name: 'Say "hi"\nnow' }, m, {});
    expect(r.text.split("\n")[0]).toBe('workflow "Say \\"hi\\"\\nnow"');
  });

  it("marks a disabled step in the outline", () => {
    const doc = five();
    (doc.steps[2] as Step).disabled = true;
    expect(overview(doc, m, {}).text).toContain("\ns3  Get deal (disabled)\n");
  });

  it("caps the ID pad at 24: a long ID overflows only its own line", () => {
    const doc = five();
    const long = `s_${"x".repeat(40)}`;
    (doc.steps[1] as Step).id = long;
    const lines = overview(doc, m, {}).text.split("\n");
    expect(lines).toContain(`${long}  Get deal`);
    expect(lines).toContain("s1  Get deal");
    const extra: Step = { id: "a_twenty_char_id_xxx", type: "crm.getDeal", config: {} };
    const out = overview({ ...doc, steps: [...doc.steps, extra] }, m, {}).text.split("\n");
    expect(out).toContain(`s1${" ".repeat(20)}Get deal`);
    expect(out).toContain(`${long}  Get deal`);
  });

  it("escapes newlines in notes so they stay on one line", () => {
    const doc = five();
    (doc.steps[0] as Step).note = 'line one\nline "two"';
    const r = overview(doc, m, {});
    expect(r.text).toContain('s1  Get deal: note "line one\\nline \\"two\\""');
    expect(r.text.split("\n").filter((l) => l.includes("line"))).toHaveLength(1);
  });

  it("a name or section title cut at 120 is listed in the notes omission", () => {
    const doc = five();
    (doc.steps[3] as Step).name = "N".repeat(200);
    doc.sections = [{ id: "a", title: "T".repeat(150), color: "blue", first: "s1", last: "s2" }];
    const r = overview(doc, m, {});
    expect(r.text).toContain(`“${"N".repeat(120)}…(+80 chars)”`);
    expect(r.text).toContain(`"${"T".repeat(120)}…(+30 chars)"`);
    expect(r.omitted).toEqual([
      {
        what: "notes",
        count: 2,
        fetch: { tool: "getSteps", args: { ids: ["s1", "s4"], include: [], full: true } },
      },
    ]);
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

  it("throws on an unknown step or branch, and on misplaced branch or after", () => {
    const doc = specExampleDoc();
    expect(() => outline(doc, m, { stepId: "nope" })).toThrow(/nope/);
    expect(() => outline(doc, m, { stepId: "recheck", branch: "maybe" })).toThrow(/maybe/);
    expect(() => outline(doc, m, { branch: "then" })).toThrow(FlowlineTreeError);
    expect(() => outline(doc, m, { branch: "then" })).toThrow(/`branch` needs `stepId`/);
    expect(() => outline(doc, m, { stepId: "recheck", after: "x" })).toThrow(/pass `branch`/);
    expect(() => outline(doc, m, { after: "notifyOwner" })).toThrow(
      /"notifyOwner" isn't in that list/,
    );
  });

  it("after the last step shows no steps and leaves nothing out", () => {
    const r = outline(specExampleDoc(), m, { after: "delay_1m" });
    expect(r.text).toBe(
      'outline({after:"delay_1m"})\n— 5 steps · 1 section · 2 notes · 1 error · 0 warnings',
    );
    expect(r.omitted).toEqual([]);
  });

  it("after a step in the middle of a section repeats the section header", () => {
    const r = outline(specExampleDoc(), m, { after: "getDeal" });
    const lines = r.text.split("\n");
    expect(lines[1]).toBe(
      '▣ section check "Check the deal" [blue]: note "Skip if the deal already moved"',
    );
    expect(lines[2]).toMatch(/^ {2}recheck +If · 1 issue$/);
    expect(r.text).not.toContain("getDeal  ");
    expect(r.text).toMatch(/\ndelay_1m +Delay\n/);
  });

  it("the subtree config follow-up includes the root step", () => {
    const doc = specExampleDoc();
    (doc.steps[1] as Step).config = { value: true, extra: "e".repeat(300) };
    const full = outline(doc, m, { stepId: "recheck" });
    const r = outline(doc, m, { stepId: "recheck", budget: resultSize(full) - 1 });
    expect(r.omitted[0]).toEqual({
      what: "config",
      count: 2,
      fetch: { tool: "getSteps", args: { ids: ["recheck", "notifyOwner"], include: ["config"] } },
    });
  });
});
