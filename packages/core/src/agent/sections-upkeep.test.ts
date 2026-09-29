/**
 * The spec §8 section-upkeep matrix, through the bulk commands. `replaceSteps` rows live in
 * `fragments.test.ts`.
 */
import { describe, expect, test } from "vitest";
import { findStep } from "../tree";
import type { Section, Step, WorkflowDoc } from "../types";
import { validateWorkflow } from "../validate";
import { apply } from "./apply";
import type { ApplyResult, Command } from "./commands";
import { richManifest } from "./fixtures";

const m = richManifest();

const delay = (id: string): Step => ({ id, type: "flow.delay", config: { duration: "1m" } });

const sec = (id: string, first: string, last: string): Section => ({
  id,
  title: id.toUpperCase(),
  color: "blue",
  first,
  last,
});

/** Top-level `a`…`e` (Delays) with `sections`. */
function flat(
  sections: Section[],
  steps: Step[] = ["a", "b", "c", "d", "e"].map(delay),
): WorkflowDoc {
  return {
    id: "f",
    name: "F",
    trigger: { type: "crm.dealStuckInStage", config: { stage: "proposal" } },
    steps,
    sections,
  };
}

function ok(r: ApplyResult): Extract<ApplyResult, { ok: true }> {
  if (!r.ok) throw new Error(`apply failed: ${JSON.stringify(r.error)}`);
  return r;
}

/** Runs `cmd` on `d`, checks no `section.*` issue, and returns the result. */
function run(d: WorkflowDoc, cmd: Command) {
  const r = ok(apply(d, [cmd], m));
  const sectionIssues = validateWorkflow(r.doc, m).filter((i) => i.code.startsWith("section."));
  expect(sectionIssues).toEqual([]);
  return r;
}

const top = (d: WorkflowDoc) => d.steps.map((s) => s.id);
const span = (d: WorkflowDoc) => d.sections?.map((s) => [s.id, s.first, s.last]);

describe("delete (s = b..d)", () => {
  test("removeSteps of the first member shrinks it", () => {
    const r = run(flat([sec("s", "b", "d")]), { op: "removeSteps", ids: ["b"] });
    expect(span(r.doc)).toEqual([["s", "c", "d"]]);
  });

  test("removeSteps of the last member shrinks it", () => {
    const r = run(flat([sec("s", "b", "d")]), { op: "removeSteps", ids: ["d"] });
    expect(span(r.doc)).toEqual([["s", "b", "c"]]);
  });

  test("removeSteps of all members removes it", () => {
    const r = run(flat([sec("s", "b", "d")]), { op: "removeSteps", first: "b", last: "d" });
    expect(r.doc.sections).toBeUndefined();
    expect(r.changed).toContain("- ▣ s");
  });
});

describe("move", () => {
  test("the whole run moves with its section", () => {
    const r = run(flat([sec("s", "b", "c")]), {
      op: "moveSteps",
      first: "b",
      last: "c",
      to: { after: "e" },
    });
    expect(top(r.doc)).toEqual(["a", "d", "e", "b", "c"]);
    expect(span(r.doc)).toEqual([["s", "b", "c"]]);
  });

  test("a part moved away leaves", () => {
    const r = run(flat([sec("s", "b", "d")]), {
      op: "moveSteps",
      first: "b",
      last: "c",
      to: { after: "e" },
    });
    expect(top(r.doc)).toEqual(["a", "d", "e", "b", "c"]);
    expect(span(r.doc)).toEqual([["s", "d", "d"]]);
  });

  test("one member moved out leaves", () => {
    const r = run(flat([sec("s", "b", "d")]), {
      op: "moveSteps",
      first: "c",
      last: "c",
      to: { after: "e" },
    });
    expect(top(r.doc)).toEqual(["a", "b", "d", "e", "c"]);
    expect(span(r.doc)).toEqual([["s", "b", "d"]]);
  });

  test("an interior pair moved up one stays in", () => {
    const r = run(flat([sec("s", "a", "d")]), {
      op: "moveSteps",
      first: "b",
      last: "c",
      to: { before: "a" },
    });
    expect(top(r.doc)).toEqual(["b", "c", "a", "d", "e"]);
    expect(span(r.doc)).toEqual([["s", "b", "d"]]);
  });

  test("a section moved onto another's span is dropped, the other stays", () => {
    const r = run(flat([sec("s", "a", "a"), sec("t", "c", "e")]), {
      op: "moveSteps",
      first: "a",
      last: "a",
      to: { after: "c" },
    });
    expect(top(r.doc)).toEqual(["b", "c", "a", "d", "e"]);
    expect(span(r.doc)).toEqual([["t", "c", "e"]]);
  });
});

describe("duplicate (s = b..c)", () => {
  test("copies of the section's run join it", () => {
    const r = run(flat([sec("s", "b", "c")]), { op: "duplicateSteps", first: "b", last: "c" });
    expect(top(r.doc)).toEqual(["a", "b", "c", "delay", "delay_2", "d", "e"]);
    expect(span(r.doc)).toEqual([["s", "b", "delay_2"]]);
  });

  test("a copy of its last member joins it", () => {
    const r = run(flat([sec("s", "b", "c")]), { op: "duplicateSteps", first: "c", last: "c" });
    expect(top(r.doc)).toEqual(["a", "b", "c", "delay", "d", "e"]);
    expect(span(r.doc)).toEqual([["s", "b", "delay"]]);
  });

  test("copies placed elsewhere don't join it", () => {
    const r = run(flat([sec("s", "b", "c")]), {
      op: "duplicateSteps",
      first: "b",
      last: "c",
      at: { after: "e" },
    });
    expect(span(r.doc)).toEqual([["s", "b", "c"]]);
  });
});

describe("wrap", () => {
  const wrapIn = (first: string, last: string): Command => ({
    op: "wrapSteps",
    first,
    last,
    in: { type: "flow.if", branch: "then", config: { value: true } },
  });

  test("the whole section run: the section holds the wrapper", () => {
    const r = run(flat([sec("s", "b", "c")]), wrapIn("b", "c"));
    expect(top(r.doc)).toEqual(["a", "if", "d", "e"]);
    expect(span(r.doc)).toEqual([["s", "if", "if"]]);
  });

  test("a run inside a section: the wrapper takes its place", () => {
    const r = run(flat([sec("s", "a", "d")]), wrapIn("b", "c"));
    expect(top(r.doc)).toEqual(["a", "if", "d", "e"]);
    expect(span(r.doc)).toEqual([["s", "a", "d"]]);
  });

  test("a run overlapping a section's start: the section becomes wrapper..last", () => {
    const r = run(flat([sec("s", "b", "d")]), wrapIn("a", "b"));
    expect(top(r.doc)).toEqual(["if", "c", "d", "e"]);
    expect(span(r.doc)).toEqual([["s", "if", "d"]]);
  });

  test("a section inside the run moves into the branch unchanged", () => {
    const d = flat([sec("s", "b", "c")]);
    const r = run(d, wrapIn("a", "d"));
    expect(top(r.doc)).toEqual(["if", "e"]);
    expect(r.doc.sections).toBe(d.sections);
    expect(findStep(r.doc, "b")?.location.parentId).toBe("if");
  });

  test.each([
    ["listed in order", [sec("s", "a", "b"), sec("t", "c", "d")]],
    ["listed reversed", [sec("t", "c", "d"), sec("s", "a", "b")]],
  ])(
    "a run touching two sections: the first holds the wrapper, the other shrinks (%s)",
    (_, sections) => {
      const r = run(flat(sections), wrapIn("b", "c"));
      expect(top(r.doc)).toEqual(["a", "if", "d", "e"]);
      expect(Object.fromEntries((span(r.doc) ?? []).map(([id, f, l]) => [id, [f, l]]))).toEqual({
        s: ["a", "if"],
        t: ["d", "d"],
      });
    },
  );

  test("a run covering a section and touching the next: the first moves in, the next holds the wrapper", () => {
    const r = run(flat([sec("s", "a", "b"), sec("t", "c", "d")]), wrapIn("a", "c"));
    expect(top(r.doc)).toEqual(["if", "d", "e"]);
    expect(span(r.doc)).toEqual([
      ["s", "a", "b"],
      ["t", "if", "d"],
    ]);
  });

  test("a run touching three sections: only the first holds the wrapper", () => {
    const r = run(
      flat([sec("s", "a", "b"), sec("t", "c", "c"), sec("u", "d", "e")]),
      wrapIn("b", "d"),
    );
    expect(top(r.doc)).toEqual(["a", "if", "e"]);
    expect(span(r.doc)).toEqual([
      ["s", "a", "if"],
      ["t", "c", "c"],
      ["u", "e", "e"],
    ]);
  });
});

describe("unwrap", () => {
  /** `a`, `w` (If: then [x, y], else [z]), `e`. */
  function wrapped(sections: Section[]): WorkflowDoc {
    return flat(sections, [
      delay("a"),
      {
        id: "w",
        type: "flow.if",
        config: { value: true },
        // biome-ignore lint/suspicious/noThenProperty: a branch ID, not a thenable
        branches: { then: [delay("x"), delay("y")], else: [delay("z")] },
      },
      delay("e"),
    ]);
  }

  test("inside a section: the kept steps take the step's place", () => {
    const r = run(wrapped([sec("s", "a", "w")]), { op: "unwrapStep", id: "w", keep: "then" });
    expect(top(r.doc)).toEqual(["a", "x", "y", "e"]);
    expect(span(r.doc)).toEqual([["s", "a", "y"]]);
  });

  test("a kept branch's own section is lifted when nothing overlaps it", () => {
    const r = run(wrapped([sec("i", "x", "y")]), { op: "unwrapStep", id: "w", keep: "then" });
    expect(span(r.doc)).toEqual([["i", "x", "y"]]);
  });

  test.each([
    ["listed after", [sec("o", "a", "w"), sec("i", "x", "y")]],
    ["listed before", [sec("i", "x", "y"), sec("o", "a", "w")]],
    ["outer is just the step, listed after", [sec("o", "w", "w"), sec("i", "x", "y")]],
    ["outer is just the step, listed before", [sec("i", "x", "y"), sec("o", "w", "w")]],
    ["outer is just the step, inner is one step", [sec("i", "x", "x"), sec("o", "w", "w")]],
  ])("a kept branch's section overlapping the outer one is dropped (%s)", (_, sections) => {
    const outer = sections.find((s) => s.id === "o") as Section;
    const r = run(wrapped(sections), { op: "unwrapStep", id: "w", keep: "then" });
    expect(span(r.doc)).toEqual([["o", outer.first === "a" ? "a" : "x", "y"]]);
    expect(r.changed).toContain("- ▣ i");
  });

  test("a section in a removed branch is removed", () => {
    const r = run(wrapped([sec("z", "z", "z")]), { op: "unwrapStep", id: "w", keep: "then" });
    expect(r.doc.sections).toBeUndefined();
  });
});
