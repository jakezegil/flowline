import { describe, expect, test } from "vitest";
import { sectionIdFor } from "../annotations";
import type { Section, Step, WorkflowDoc } from "../types";
import { type Issue, validateWorkflow } from "../validate";
import { apply } from "./apply";
import { richManifest } from "./fixtures";
import { annotationRepairs } from "./repairs";

const m = richManifest();

const delay = (id: string, extra: Partial<Step> = {}): Step => ({
  id,
  type: "flow.delay",
  config: { duration: "1m" },
  ...extra,
});

/** `a`, `b`, `c`, `check` (If: then `x`, `y`), `d`. */
function doc(sections: Section[], steps?: Step[]): WorkflowDoc {
  return {
    id: "t",
    name: "T",
    trigger: { type: "crm.dealStuckInStage", config: { stage: "proposal" } },
    steps: steps ?? [
      delay("a"),
      delay("b"),
      delay("c"),
      {
        id: "check",
        type: "flow.if",
        config: { value: true },
        // biome-ignore lint/suspicious/noThenProperty: a branch ID, not a thenable
        branches: { then: [delay("x"), delay("y")], else: [] },
      },
      delay("d"),
    ],
    sections,
  };
}

const sec = (id: string, first: string, last: string, extra: Partial<Section> = {}): Section => ({
  id,
  title: id.toUpperCase(),
  color: "blue",
  first,
  last,
  ...extra,
});

const key = (i: Issue) => JSON.stringify([i.code, i.stepId, i.sectionId, i.message]);
const annotation = (d: WorkflowDoc) =>
  validateWorkflow(d, m).filter((i) => i.code.startsWith("section.") || i.code === "note.tooLong");

/** Fixes `issue` in `d`: the repaired doc, after checking the issue is gone. */
function fix(d: WorkflowDoc, issue: Issue): WorkflowDoc {
  const cmds = annotationRepairs(d, issue);
  expect(cmds.length).toBeGreaterThan(0);
  const r = apply(d, cmds, m);
  if (!r.ok) throw new Error(`repair failed: ${JSON.stringify(r.error)}`);
  expect(annotation(r.doc).map(key)).not.toContain(key(issue));
  return r.doc;
}

function only(d: WorkflowDoc, match: (i: Issue) => boolean): Issue {
  const found = annotation(d).filter(match);
  expect(found).toHaveLength(1);
  return found[0] as Issue;
}

describe("annotationRepairs", () => {
  test("a missing endpoint with one survivor shrinks the section to it", () => {
    const d = doc([sec("s", "zz", "b")]);
    const issue = only(d, (i) => i.message.includes('"zz" is missing'));
    expect(annotationRepairs(d, issue)).toEqual([
      { op: "updateSection", id: "s", first: "b", last: "b" },
    ]);
    expect(fix(d, issue).sections).toEqual([sec("s", "b", "b")]);
  });

  test("a missing endpoint with no survivor removes the section", () => {
    const d = doc([sec("s", "zz", "qq")]);
    const issue = annotation(d)[0] as Issue;
    expect(annotationRepairs(d, issue)).toEqual([{ op: "removeSection", id: "s" }]);
    expect(fix(d, issue).sections).toBeUndefined();
  });

  test("a reversed section swaps first and last", () => {
    const d = doc([sec("s", "c", "a")]);
    const issue = only(d, (i) => i.message.includes("comes after"));
    expect(annotationRepairs(d, issue)).toEqual([
      { op: "updateSection", id: "s", first: "a", last: "c" },
    ]);
    expect(fix(d, issue).sections).toEqual([sec("s", "a", "c")]);
  });

  test("first and last in different branches shrink the section to its first step", () => {
    const d = doc([sec("s", "b", "x")]);
    const issue = only(d, (i) => i.message.includes("different branches"));
    expect(annotationRepairs(d, issue)).toEqual([{ op: "updateSection", id: "s", last: "b" }]);
    expect(fix(d, issue).sections).toEqual([sec("s", "b", "b")]);
  });

  test("a bad colour becomes gray", () => {
    const d = doc([sec("s", "a", "b", { color: "red" as never })]);
    const issue = only(d, (i) => i.message.includes("colour"));
    expect(annotationRepairs(d, issue)).toEqual([{ op: "updateSection", id: "s", color: "gray" }]);
    expect(fix(d, issue).sections?.[0]?.color).toBe("gray");
  });

  test("a duplicate ID: the first keeps it, the later gets sectionIdFor(title)", () => {
    const d = doc([
      sec("g", "a", "a", { title: "Group" }),
      sec("g", "c", "c", { title: "Group", note: "N", color: "pink" }),
    ]);
    const issue = only(d, (i) => i.message.includes("used twice"));
    const fresh = sectionIdFor(d, "Group");
    expect(fresh).toBe("group");
    expect(annotationRepairs(d, issue)).toEqual([
      { op: "removeSection", id: "g" },
      {
        op: "addSection",
        first: "c",
        last: "c",
        title: "Group",
        color: "pink",
        note: "N",
        id: fresh,
      },
    ]);
    expect(fix(d, issue).sections).toEqual([
      sec("g", "a", "a", { title: "Group" }),
      { id: "group", title: "Group", color: "pink", note: "N", first: "c", last: "c" },
    ]);
  });

  test("an invalid ID is replaced with sectionIdFor(title)", () => {
    const d = doc([sec("not valid", "a", "b", { title: "Check it" })]);
    const issue = only(d, (i) => i.message.includes("invalid"));
    const next = fix(d, issue);
    expect(next.sections).toEqual([sec("check_it", "a", "b", { title: "Check it" })]);
  });

  test("an overlap removes the later section", () => {
    const d = doc([sec("s", "a", "b"), sec("t", "b", "c")]);
    const issue = only(d, (i) => i.code === "section.overlap");
    expect(annotationRepairs(d, issue)).toEqual([{ op: "removeSection", id: "t" }]);
    expect(fix(d, issue).sections).toEqual([sec("s", "a", "b")]);
  });

  test("a long step note is cut to 4000 chars", () => {
    const d = doc([]);
    d.steps[1] = delay("b", { note: "x".repeat(5000) });
    const issue = only(d, (i) => i.code === "note.tooLong");
    expect(annotationRepairs(d, issue)).toEqual([
      { op: "setNote", id: "b", note: "x".repeat(4000) },
    ]);
    const next = fix(d, issue);
    expect(next.steps[1]?.note).toHaveLength(4000);
  });

  test("a long section note is cut to 4000 chars", () => {
    const d = doc([sec("s", "a", "b", { note: "y".repeat(5000) })]);
    const issue = only(d, (i) => i.code === "note.tooLong");
    expect(annotationRepairs(d, issue)).toEqual([
      { op: "updateSection", id: "s", note: "y".repeat(4000) },
    ]);
    expect(fix(d, issue).sections?.[0]?.note).toHaveLength(4000);
  });

  test("other issues get no repair", () => {
    const d = doc([]);
    d.steps[0] = { id: "a", type: "flow.delay", config: {} };
    const issue = validateWorkflow(d, m).find((i) => i.stepId === "a") as Issue;
    expect(issue).toBeDefined();
    expect(annotationRepairs(d, issue)).toEqual([]);
  });

  test("a stale issue (its section gone) gets no repair", () => {
    const d = doc([sec("s", "a", "b", { color: "red" as never })]);
    const issue = only(d, (i) => i.message.includes("colour"));
    expect(annotationRepairs(doc([]), issue)).toEqual([]);
  });
});

describe("$-prefixed section IDs (M5)", () => {
  test("an invalid $x ID is re-id'd", () => {
    const d = doc([sec("$x", "a", "b", { title: "Check" })]);
    const issue = only(d, (i) => i.message.includes("invalid"));
    expect(annotationRepairs(d, issue)).toEqual([
      { op: "removeSection", id: "$x" },
      { op: "addSection", first: "a", last: "b", title: "Check", color: "blue", id: "check" },
    ]);
    expect(fix(d, issue).sections).toEqual([sec("check", "a", "b", { title: "Check" })]);
  });

  test("a $1 ID is re-id'd too, and its other fixes run on it", () => {
    const d = doc([sec("$1", "c", "a", { title: "One" })]);
    for (const issue of annotation(d)) fix(d, issue);
  });

  test("two same-$2-ID sections: a fix that would name $2 after an addSection defines it gives []", () => {
    const d = doc([
      sec("$2", "a", "a", { title: "One", color: "red" as never }),
      sec("$2", "c", "c", { title: "Two" }),
    ]);
    const issue = only(d, (i) => i.message.includes("colour"));
    // [removeSection $2, addSection (defines $2), updateSection $2] would hit the new section.
    expect(annotationRepairs(d, issue)).toEqual([]);
  });

  test("two same-$1-ID sections: $1 stays literal (commands[0] defines nothing)", () => {
    const d = doc([
      sec("$1", "a", "a", { title: "One", color: "red" as never }),
      sec("$1", "c", "c", { title: "Two" }),
    ]);
    const issue = only(d, (i) => i.message.includes("colour"));
    // [removeSection $1, addSection (defines $2), updateSection $1]: $1 is still literal here.
    const cmds = annotationRepairs(d, issue);
    expect(cmds).toHaveLength(3);
    fix(d, issue);
  });
});

describe("duplicate section IDs: the re-id repair runs first (Task 1 M3)", () => {
  test("a fix for the earlier of two same-ID sections targets the earlier one", () => {
    const d = doc([
      sec("g", "a", "a", { title: "One", color: "red" as never }),
      sec("g", "c", "c", { title: "Two" }),
    ]);
    const issue = only(d, (i) => i.message.includes("colour"));
    const cmds = annotationRepairs(d, issue);
    expect(cmds[0]).toEqual({ op: "removeSection", id: "g" });
    const next = fix(d, issue);
    expect(next.sections).toEqual([
      sec("g", "a", "a", { title: "One", color: "gray" }),
      sec("two", "c", "c", { title: "Two" }),
    ]);
  });

  test("a fix for the later one acts on it directly", () => {
    const d = doc([
      sec("g", "a", "a", { title: "One" }),
      sec("g", "c", "c", { title: "Two", color: "red" as never }),
    ]);
    const issue = only(d, (i) => i.message.includes("colour"));
    expect(annotationRepairs(d, issue)).toEqual([{ op: "updateSection", id: "g", color: "gray" }]);
    fix(d, issue);
  });

  test("a duplicate that overlaps the earlier copy is removed, not re-added", () => {
    const d = doc([sec("g", "a", "b"), sec("g", "a", "b")]);
    const dup = only(d, (i) => i.message.includes("used twice"));
    expect(annotationRepairs(d, dup)).toEqual([{ op: "removeSection", id: "g" }]);
    expect(fix(d, dup).sections).toEqual([sec("g", "a", "b")]);
  });

  test("a broken duplicate is re-added repaired", () => {
    const d = doc([
      sec("g", "a", "a", { title: "One" }),
      sec("g", "zz", "c", { title: "Two", color: "red" as never, note: "n".repeat(4500) }),
    ]);
    const dup = only(d, (i) => i.message.includes("used twice"));
    const next = fix(d, dup);
    expect(next.sections?.[1]).toEqual({
      id: "two",
      title: "Two",
      color: "gray",
      note: "n".repeat(4000),
      first: "c",
      last: "c",
    });
  });

  test("every annotation issue of a messy doc can be fixed one at a time (Review Focus 3)", () => {
    let d = doc([
      sec("s1", "zz", "b"),
      sec("s2", "c", "a"),
      sec("s3", "b", "x", { color: "red" as never }),
      sec("s1", "d", "d", { note: "z".repeat(5000) }),
      sec("bad id", "check", "check"),
      sec("s6", "d", "d"),
    ]);
    for (let round = 0; round < 20; round++) {
      const issues = annotation(d);
      if (issues.length === 0) break;
      const cmds = annotationRepairs(d, issues[0] as Issue);
      expect(cmds.length, JSON.stringify(issues[0])).toBeGreaterThan(0);
      const r = apply(d, cmds, m);
      if (!r.ok) throw new Error(`repair failed: ${JSON.stringify(r.error)}`);
      d = r.doc;
    }
    expect(annotation(d)).toEqual([]);
  });
});
