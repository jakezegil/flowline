import { describe, expect, it } from "vitest";
import {
  ANNOTATION_COLORS,
  isAnnotationColor,
  NOTE_MAX_CHARS,
  sectionIdFor,
  sectionOf,
  sectionRun,
  upkeepSections,
} from "./annotations";
import type { AnnotationColor, Section, Step, WorkflowDoc } from "./types";

const s = (id: string, extra: Partial<Step> = {}): Step => ({
  id,
  type: "t.x",
  config: {},
  ...extra,
});

function doc(steps: Step[], sections?: Section[]): WorkflowDoc {
  return {
    id: "wf",
    name: "W",
    trigger: { type: "t.manual", config: {} },
    steps,
    ...(sections ? { sections } : {}),
  };
}

const section = (
  id: string,
  first: string,
  last: string,
  extra: Partial<Section> = {},
): Section => ({
  id,
  title: id,
  color: "blue",
  first,
  last,
  ...extra,
});

/** [a, cond{if:[x,y], else:[p,q,r]}, b] */
function nested(sections?: Section[]): WorkflowDoc {
  return doc(
    [
      s("a"),
      s("cond", { branches: { if: [s("x"), s("y")], else: [s("p"), s("q"), s("r")] } }),
      s("b"),
    ],
    sections,
  );
}

describe("constants", () => {
  it("lists the six colours in order", () => {
    expect(ANNOTATION_COLORS).toEqual(["yellow", "blue", "green", "pink", "purple", "gray"]);
    expect(NOTE_MAX_CHARS).toBe(4000);
  });

  it("isAnnotationColor accepts only the six", () => {
    for (const c of ANNOTATION_COLORS) expect(isAnnotationColor(c)).toBe(true);
    expect(isAnnotationColor("red")).toBe(false);
    expect(isAnnotationColor(1)).toBe(false);
    expect(isAnnotationColor(undefined)).toBe(false);
  });
});

describe("sectionRun", () => {
  it("returns a top-level run", () => {
    const d = nested();
    expect(sectionRun(d, section("s", "a", "b"))).toEqual({
      parentId: null,
      start: 0,
      end: 2,
      ids: ["a", "cond", "b"],
    });
  });

  it("returns a run inside else", () => {
    const d = nested();
    expect(sectionRun(d, section("s", "q", "r"))).toEqual({
      parentId: "cond",
      branch: "else",
      start: 1,
      end: 2,
      ids: ["q", "r"],
    });
  });

  it("returns a one-step run", () => {
    expect(sectionRun(nested(), section("s", "x", "x"))).toEqual({
      parentId: "cond",
      branch: "if",
      start: 0,
      end: 0,
      ids: ["x"],
    });
  });

  it("is undefined when an endpoint is missing", () => {
    expect(sectionRun(nested(), section("s", "nope", "b"))).toBeUndefined();
    expect(sectionRun(nested(), section("s", "a", "nope"))).toBeUndefined();
  });

  it("is undefined when the endpoints are in two lists", () => {
    expect(sectionRun(nested(), section("s", "x", "q"))).toBeUndefined();
    expect(sectionRun(nested(), section("s", "a", "x"))).toBeUndefined();
  });

  it("is undefined when reversed", () => {
    expect(sectionRun(nested(), section("s", "b", "a"))).toBeUndefined();
  });

  it("still returns the run for a bad colour or ID", () => {
    const bad = section("1 bad", "a", "cond", { color: "red" as AnnotationColor });
    expect(sectionRun(nested(), bad)?.ids).toEqual(["a", "cond"]);
  });
});

describe("sectionOf", () => {
  const outer = section("outer", "a", "cond");
  const inner = section("inner", "p", "q");
  const d = nested([outer, inner]);

  it("finds the section of a member in its own list", () => {
    expect(sectionOf(d, "a")).toBe(outer);
    expect(sectionOf(d, "cond")).toBe(outer);
    expect(sectionOf(d, "q")).toBe(inner);
  });

  it("is undefined outside every run, and for steps only nested under a section", () => {
    expect(sectionOf(d, "b")).toBeUndefined();
    expect(sectionOf(d, "r")).toBeUndefined();
    // x is inside cond (a member of outer), but not in outer's own list.
    expect(sectionOf(d, "x")).toBeUndefined();
    expect(sectionOf(d, "missing")).toBeUndefined();
  });
});

describe("upkeepSections", () => {
  it("returns after itself when there are no sections", () => {
    const before = doc([s("a"), s("b")]);
    const after = doc([s("a")]);
    expect(upkeepSections(before, after)).toBe(after);
  });

  it("leaves a section broken in before unchanged", () => {
    const broken = section("s", "zz", "b");
    const before = doc([s("a"), s("b")], [broken]);
    const after = { ...before, steps: [s("a")] };
    const out = upkeepSections(before, after);
    expect(out).toBe(after);
    expect(out.sections?.[0]).toBe(broken);
  });

  it("applies subst for a wrap-like edit", () => {
    const before = doc([s("a"), s("b"), s("c"), s("d")], [section("s", "b", "c")]);
    const after = { ...before, steps: [s("a"), s("w1"), s("w2"), s("d")] };
    const out = upkeepSections(before, after, {
      subst: new Map([
        ["b", ["w1"]],
        ["c", ["w2"]],
      ]),
    });
    expect(out.sections).toEqual([section("s", "w1", "w2")]);
  });

  it("keeps the whole run when every member moved", () => {
    const before = doc([s("a"), s("b"), s("c"), s("d")], [section("s", "b", "c")]);
    const after = { ...before, steps: [s("b"), s("c"), s("a"), s("d")] };
    const out = upkeepSections(before, after, { moved: new Set(["b", "c"]) });
    expect(out.sections).toEqual([section("s", "b", "c")]);
  });

  it("drops the moved section when a whole-run move lands inside another", () => {
    const one = section("one", "b", "b");
    const two = section("two", "d", "e", { note: "keep me" });
    const before = doc([s("a"), s("b"), s("c"), s("d"), s("e")], [one, two]);
    // b moved alone between d and e.
    const after = { ...before, steps: [s("a"), s("c"), s("d"), s("b"), s("e")] };
    const out = upkeepSections(before, after, { moved: new Set(["b"]) });
    expect(out.sections).toEqual([two]);
    expect(out.sections?.[0]).toBe(two);
  });

  it("mirror: a moved multi-step section overlapping a one-step section that stays is dropped", () => {
    for (const order of ["movedFirst", "movedLast"] as const) {
      const multi = section("multi", "b", "c", { note: "moves" });
      const single = section("single", "e", "e", { title: "Stays", note: "stay" });
      const sections = order === "movedFirst" ? [multi, single] : [single, multi];
      const before = doc([s("a"), s("b"), s("c"), s("d"), s("e")], sections);
      // b and c moved together onto e: [a, d, b, e, c] puts e inside b..c.
      const after = { ...before, steps: [s("a"), s("d"), s("b"), s("e"), s("c")] };
      const out = upkeepSections(before, after, { moved: new Set(["b", "c"]) });
      expect(out.sections).toEqual([single]);
      expect(out.sections?.[0]).toBe(single);
    }
  });

  it("drops the later section when both or neither moved", () => {
    const one = section("one", "a", "a");
    const two = section("two", "b", "b");
    const before = doc([s("a"), s("b"), s("c")], [one, two]);
    // Neither moved: a subst makes both cover the same step.
    const after = { ...before, steps: [s("m"), s("c")] };
    const out = upkeepSections(before, after, {
      subst: new Map([
        ["a", ["m"]],
        ["b", ["m"]],
      ]),
    });
    expect(out.sections).toEqual([section("one", "m", "m")]);
    // Both moved: [c, a, d, b] puts d inside a..b.
    const both = doc(
      [s("a"), s("b"), s("c"), s("d")],
      [section("one", "a", "b"), section("two", "d", "d")],
    );
    const after2 = { ...both, steps: [s("c"), s("a"), s("d"), s("b")] };
    const out2 = upkeepSections(both, after2, { moved: new Set(["a", "b", "d"]) });
    expect(out2.sections).toEqual([section("one", "a", "b")]);
  });

  it("leaves an overlap that was already there to the validator", () => {
    const one = section("one", "a", "c");
    const two = section("two", "b", "d");
    const before = doc([s("a"), s("b"), s("c"), s("d"), s("e")], [one, two]);
    const after = { ...before, steps: before.steps.slice(0, 4) };
    expect(upkeepSections(before, after)).toBe(after);
  });

  it("keeps sections: [] when it was [] before", () => {
    const before = doc([s("a")], []);
    const after = { ...before, steps: [] };
    expect(upkeepSections(before, after)).toBe(after);
  });
});

describe("sectionIdFor", () => {
  it("slugs a title", () => {
    expect(sectionIdFor(doc([]), "Check the deal")).toBe("check_the_deal");
  });

  it("appends a counter when the ID is taken", () => {
    const d = doc([], [section("check_the_deal", "a", "a")]);
    expect(sectionIdFor(d, "Check the deal")).toBe("check_the_deal_2");
    const d3 = doc(
      [],
      [section("check_the_deal", "a", "a"), section("check_the_deal_2", "a", "a")],
    );
    expect(sectionIdFor(d3, "Check the deal")).toBe("check_the_deal_3");
  });

  it("falls back to section when nothing is left", () => {
    expect(sectionIdFor(doc([]), "!!!")).toBe("section");
  });

  it("prefixes a leading digit", () => {
    expect(sectionIdFor(doc([]), "2024 plan")).toBe("section_2024_plan");
  });

  it("cuts a long title to 32 chars", () => {
    const id = sectionIdFor(doc([]), "Abcdefghij".repeat(5));
    expect(id).toBe("abcdefghij".repeat(5).slice(0, 32));
    expect(id).toHaveLength(32);
  });

  it("never returns a reserved step ID", () => {
    expect(sectionIdFor(doc([]), "Constructor")).toBe("constructor_2");
  });
});
