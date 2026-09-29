import { describe, expect, test } from "vitest";
import { sectionRun } from "../annotations";
import type { Section, WorkflowDoc } from "../types";
import { apply } from "./apply";
import type { ApplyResult, Command } from "./commands";
import { richManifest } from "./fixtures";

const m = richManifest();

const delay = (id: string) => ({ id, type: "flow.delay", config: { duration: "1m" } });

/** `a`, `b`, `c`, `check` (If: then `x`, `y`), `d`. */
function doc(sections?: Section[]): WorkflowDoc {
  return {
    id: "t",
    name: "T",
    trigger: { type: "crm.dealStuckInStage", config: { stage: "proposal" } },
    steps: [
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
    ...(sections ? { sections } : {}),
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

function ok(r: ApplyResult): Extract<ApplyResult, { ok: true }> {
  if (!r.ok) throw new Error(`apply failed: ${JSON.stringify(r.error)}`);
  return r;
}

function fail(r: ApplyResult): Extract<ApplyResult, { ok: false }> {
  if (r.ok) throw new Error("apply unexpectedly succeeded");
  return r;
}

const addDelay: Command = {
  op: "addStep",
  at: { after: "d" },
  type: "flow.delay",
  config: { duration: "2m" },
};

interface Row {
  op: string;
  input: () => WorkflowDoc;
  normal: Command;
  check: (after: WorkflowDoc, r: Extract<ApplyResult, { ok: true }>) => void;
  notFound: { cmd: Command; code: string; path: string };
  /** Commands run after `addDelay` (so `$1` is the new step `delay`). */
  dollar: {
    cmds: Command[];
    check: (after: WorkflowDoc, r: Extract<ApplyResult, { ok: true }>) => void;
  };
}

const rows: Row[] = [
  {
    op: "addSection",
    input: () => doc(),
    normal: {
      op: "addSection",
      first: "a",
      last: "b",
      title: "Group A",
      color: "green",
      note: "Why",
    },
    check: (d, r) => {
      expect(d.sections).toEqual([
        { id: "group_a", title: "Group A", color: "green", note: "Why", first: "a", last: "b" },
      ]);
      expect(r.ids).toEqual({ $1: "group_a" });
    },
    notFound: {
      cmd: { op: "addSection", first: "nope", last: "b", title: "T", color: "blue" },
      code: "step.notFound",
      path: "first",
    },
    dollar: {
      cmds: [{ op: "addSection", first: "d", last: "$1", title: "Tail", color: "gray" }],
      check: (d, r) => {
        expect(d.sections).toEqual([
          { id: "tail", title: "Tail", color: "gray", first: "d", last: "delay" },
        ]);
        expect(r.ids).toEqual({ $1: "delay", $2: "tail" });
      },
    },
  },
  {
    op: "updateSection",
    input: () => doc([sec("s", "a", "b")]),
    normal: { op: "updateSection", id: "s", title: "New", color: "pink", note: "N", last: "c" },
    check: (d) =>
      expect(d.sections).toEqual([
        { id: "s", title: "New", color: "pink", note: "N", first: "a", last: "c" },
      ]),
    notFound: {
      cmd: { op: "updateSection", id: "nope", color: "pink" },
      code: "section.notFound",
      path: "id",
    },
    dollar: {
      cmds: [{ op: "updateSection", id: "s", first: "d", last: "$1" }],
      check: (d) => expect(d.sections).toEqual([sec("s", "d", "delay")]),
    },
  },
  {
    op: "removeSection",
    input: () => doc([sec("s", "a", "b"), sec("t", "c", "c")]),
    normal: { op: "removeSection", id: "s" },
    check: (d) => {
      expect(d.sections).toEqual([sec("t", "c", "c")]);
      expect(d.steps.map((s) => s.id)).toEqual(["a", "b", "c", "check", "d"]);
    },
    notFound: { cmd: { op: "removeSection", id: "nope" }, code: "section.notFound", path: "id" },
    dollar: {
      cmds: [
        { op: "addSection", first: "$1", last: "$1", title: "New", color: "blue" },
        { op: "removeSection", id: "$2" },
      ],
      check: (d, r) => {
        expect(d.sections).toEqual([sec("s", "a", "b"), sec("t", "c", "c")]);
        expect(r.ids).toEqual({ $1: "delay", $2: "new" });
      },
    },
  },
];

describe.each(rows)("$op", (row) => {
  test("normal case", () => {
    const d = row.input();
    const before = structuredClone(d);
    const r = ok(apply(d, [row.normal], m));
    row.check(r.doc, r);
    expect(d).toEqual(before);
    const trusted = ok(apply(row.input(), [row.normal], m, { trusted: true, report: false }));
    expect(trusted.doc).toEqual(r.doc);
  });

  test("an unknown target fails and leaves the input untouched", () => {
    const d = row.input();
    const before = structuredClone(d);
    const r = fail(apply(d, [row.notFound.cmd], m));
    expect(r.error.code).toBe(row.notFound.code);
    expect(r.error.path).toBe(`commands[0].${row.notFound.path}`);
    expect(r.error.hint).toBeDefined();
    expect(d).toEqual(before);
  });

  test("$n addresses what an earlier command created", () => {
    const r = ok(apply(row.input(), [addDelay, ...row.dollar.cmds], m));
    row.dollar.check(r.doc, r);
  });

  test("atomic: a failing next command leaves the input deep-equal to its clone", () => {
    const d = row.input();
    const before = structuredClone(d);
    const r = fail(apply(d, [row.normal, { op: "removeStep", id: "nope" }], m));
    expect(r.error.index).toBe(1);
    expect(d).toEqual(before);
  });
});

describe("addSection", () => {
  test("reversed fails with run.invalid and both locations", () => {
    const r = fail(
      apply(doc(), [{ op: "addSection", first: "c", last: "a", title: "T", color: "blue" }], m),
    );
    expect(r.error).toMatchObject({
      code: "run.invalid",
      path: "commands[0]",
      hint: { first: { parentId: null, index: 2 }, last: { parentId: null, index: 0 } },
    });
  });

  test("two lists fail with run.invalid", () => {
    const r = fail(
      apply(doc(), [{ op: "addSection", first: "a", last: "x", title: "T", color: "blue" }], m),
    );
    expect(r.error).toMatchObject({
      code: "run.invalid",
      hint: {
        first: { parentId: null, index: 0 },
        last: { parentId: "check", branch: "then", index: 0 },
      },
    });
  });

  test("overlap with a section in the same list fails with section.overlap", () => {
    const r = fail(
      apply(
        doc([sec("s", "b", "c")]),
        [{ op: "addSection", first: "a", last: "b", title: "T", color: "blue" }],
        m,
      ),
    );
    expect(r.error).toMatchObject({ code: "section.overlap", hint: { section: "s" } });
  });

  test("nesting inside a branch of a step in another section is allowed", () => {
    const r = ok(
      apply(
        doc([sec("s", "c", "check")]),
        [{ op: "addSection", first: "x", last: "y", title: "Inner", color: "pink" }],
        m,
      ),
    );
    expect(r.doc.sections?.map((s) => s.id)).toEqual(["s", "inner"]);
  });

  test("a single-step run is fine; the ID is unique among sections", () => {
    const r = ok(
      apply(
        doc([sec("t", "a", "a")]),
        [{ op: "addSection", first: "b", last: "b", title: "T", color: "blue" }],
        m,
      ),
    );
    expect(r.doc.sections?.[1]?.id).toBe("t_2");
  });

  test("an explicit ID: taken fails with id.taken, invalid with id.invalid", () => {
    const taken = fail(
      apply(
        doc([sec("t", "a", "a")]),
        [{ op: "addSection", first: "b", last: "b", title: "T", color: "blue", id: "t" }],
        m,
      ),
    );
    expect(taken.error).toMatchObject({
      code: "id.taken",
      path: "commands[0].id",
      hint: { suggested: "t_2" },
    });
    const invalid = fail(
      apply(
        doc(),
        [{ op: "addSection", first: "b", last: "b", title: "T", color: "blue", id: "9 x" }],
        m,
      ),
    );
    expect(invalid.error).toMatchObject({ code: "id.invalid", path: "commands[0].id" });
  });

  test("an explicit ID is used", () => {
    const r = ok(
      apply(
        doc(),
        [{ op: "addSection", first: "b", last: "c", title: "T", color: "blue", id: "mine" }],
        m,
      ),
    );
    expect(r.doc.sections?.[0]?.id).toBe("mine");
    expect(r.ids.$1).toBe("mine");
  });

  test("a broken section doesn't block a new one", () => {
    const r = ok(
      apply(
        doc([sec("gone", "zz", "b")]),
        [{ op: "addSection", first: "a", last: "b", title: "T", color: "blue" }],
        m,
      ),
    );
    expect(r.doc.sections).toHaveLength(2);
  });

  test("changed shows the new section", () => {
    const r = ok(
      apply(doc(), [{ op: "addSection", first: "a", last: "b", title: "T", color: "blue" }], m),
    );
    expect(r.changed).toBe('+ ▣ section t "T" [blue]');
  });
});

describe("updateSection", () => {
  test("retargeting re-checks the run and overlap", () => {
    const d = doc([sec("s", "a", "b"), sec("t", "d", "d")]);
    expect(
      ok(apply(d, [{ op: "updateSection", id: "s", first: "b", last: "c" }], m)).doc.sections?.[0],
    ).toEqual(sec("s", "b", "c"));
    expect(fail(apply(d, [{ op: "updateSection", id: "s", last: "d" }], m)).error).toMatchObject({
      code: "section.overlap",
      hint: { section: "t" },
    });
    expect(fail(apply(d, [{ op: "updateSection", id: "s", first: "c" }], m)).error.code).toBe(
      "run.invalid",
    );
    expect(fail(apply(d, [{ op: "updateSection", id: "s", last: "x" }], m)).error.code).toBe(
      "run.invalid",
    );
    expect(fail(apply(d, [{ op: "updateSection", id: "s", last: "zz" }], m)).error).toMatchObject({
      code: "step.notFound",
      path: "commands[0].last",
    });
  });

  test("shrinking inside its own run doesn't count as an overlap with itself", () => {
    const d = doc([sec("s", "a", "c")]);
    expect(ok(apply(d, [{ op: "updateSection", id: "s", first: "b" }], m)).doc.sections).toEqual([
      sec("s", "b", "c"),
    ]);
  });

  test("note null or '' removes the note", () => {
    const d = doc([sec("s", "a", "b", { note: "N" })]);
    for (const note of [null, ""]) {
      expect(ok(apply(d, [{ op: "updateSection", id: "s", note }], m)).doc.sections).toEqual([
        sec("s", "a", "b"),
      ]);
    }
  });

  test("the same values are a no-op returning the input doc", () => {
    const d = doc([sec("s", "a", "b", { note: "N" })]);
    const cmd: Command = {
      op: "updateSection",
      id: "s",
      title: "S",
      color: "blue",
      note: "N",
      first: "a",
      last: "b",
    };
    expect(ok(apply(d, [cmd], m)).doc).toBe(d);
    expect(ok(apply(d, [{ op: "updateSection", id: "s" }], m)).doc).toBe(d);
    const plain = doc([sec("s", "a", "b")]);
    expect(ok(apply(plain, [{ op: "updateSection", id: "s", note: null }], m)).doc).toBe(plain);
  });

  test("an unknown ID's hint lists the section IDs", () => {
    const r = fail(
      apply(doc([sec("s", "a", "b"), sec("t", "c", "c")]), [{ op: "removeSection", id: "q" }], m),
    );
    expect(r.error).toMatchObject({
      code: "section.notFound",
      message: 'Section "q" not found',
      hint: { sections: ["s", "t"] },
    });
  });

  test("a colour fix on a broken section doesn't need a valid run", () => {
    const d = doc([sec("s", "zz", "b", { color: "red" as never })]);
    expect(
      ok(apply(d, [{ op: "updateSection", id: "s", color: "gray" }], m)).doc.sections?.[0]?.color,
    ).toBe("gray");
  });
});

describe("duplicated section IDs act on the later one", () => {
  const d = () => doc([sec("g", "a", "a"), sec("g", "c", "c")]);
  test("updateSection", () => {
    const r = ok(apply(d(), [{ op: "updateSection", id: "g", color: "pink" }], m));
    expect(r.doc.sections?.map((s) => s.color)).toEqual(["blue", "pink"]);
  });
  test("removeSection", () => {
    const r = ok(apply(d(), [{ op: "removeSection", id: "g" }], m));
    expect(r.doc.sections).toEqual([sec("g", "a", "a")]);
  });
});

describe("removeSection", () => {
  test("removing the last section removes the sections key", () => {
    const r = ok(apply(doc([sec("s", "a", "b")]), [{ op: "removeSection", id: "s" }], m));
    expect("sections" in r.doc).toBe(false);
    expect(r.changed).toBe("- ▣ s");
  });
});

describe("section placeholders (S11)", () => {
  test("$1 resolves to the new section's ID through update and remove", () => {
    const d = doc();
    const r = ok(
      apply(
        d,
        [
          { op: "addSection", first: "a", last: "b", title: "Group", color: "blue" },
          { op: "updateSection", id: "$1", color: "green" },
          { op: "removeSection", id: "$1" },
        ],
        m,
      ),
    );
    expect(r.ids).toEqual({ $1: "group" });
    expect(r.doc.sections).toBeUndefined();
  });

  test("an unknown $2 fails with placeholder.unknown", () => {
    const r = fail(
      apply(
        doc(),
        [
          { op: "addSection", first: "a", last: "b", title: "Group", color: "blue" },
          { op: "updateSection", id: "$2", color: "green" },
        ],
        m,
      ),
    );
    expect(r.error).toMatchObject({
      code: "placeholder.unknown",
      path: "commands[1].id",
      hint: { defined: ["$1"] },
    });
  });
});

describe("section upkeep through apply (Review Focus 1)", () => {
  test("moveStep of a section's first shrinks the section", () => {
    const r = ok(
      apply(doc([sec("s", "a", "c")]), [{ op: "moveStep", id: "a", to: { after: "d" } }], m),
    );
    expect(r.doc.sections).toEqual([sec("s", "b", "c")]);
  });

  test("⌥↑ of an interior member via moveStep keeps the section", () => {
    const d = doc([sec("s", "a", "c")]);
    const r = ok(apply(d, [{ op: "moveStep", id: "b", to: { before: "a" } }], m));
    const s = r.doc.sections?.[0] as Section;
    expect(sectionRun(r.doc, s)?.ids).toEqual(["b", "a", "c"]);
  });

  test("removeStep of the only member removes the section", () => {
    const r = ok(apply(doc([sec("s", "b", "b")]), [{ op: "removeStep", id: "b" }], m));
    expect(r.doc.sections).toBeUndefined();
  });

  test("duplicateStep of last extends the section; setType keeps it", () => {
    const r = ok(
      apply(
        doc([sec("s", "a", "b")]),
        [
          { op: "duplicateStep", id: "b" },
          { op: "setType", id: "$1", type: "crm.getDeal" },
        ],
        m,
      ),
    );
    expect(r.doc.sections).toEqual([sec("s", "a", r.ids.$2 as string)]);
    expect(r.ids.$2).toBe("getDeal");
  });
});
