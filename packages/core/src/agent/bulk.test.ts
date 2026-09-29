import { describe, expect, test } from "vitest";
import { findStep } from "../tree";
import type { Section, Step, WorkflowDoc } from "../types";
import { apply } from "./apply";
import { commandSchema, whereSchema } from "./command-schema";
import type { ApplyResult, Command } from "./commands";
import { flatDoc, richManifest } from "./fixtures";

const m = richManifest();

const trigger: WorkflowDoc["trigger"] = {
  type: "crm.dealStuckInStage",
  config: { stage: "proposal" },
};

/** `load` (getDeal), `check` (If) with `notify` in `then`, `wait` (Delay). */
function doc(sections?: Section[]): WorkflowDoc {
  return {
    id: "t",
    name: "T",
    trigger,
    steps: [
      { id: "load", type: "crm.getDeal", config: { dealId: { $ref: "trigger.deal.id" } } },
      {
        id: "check",
        type: "flow.if",
        config: { value: true },
        branches: {
          // biome-ignore lint/suspicious/noThenProperty: a branch ID, not a thenable
          then: [
            {
              id: "notify",
              type: "crm.sendEmail",
              config: { to: { $ref: "steps.load.deal.ownerId" }, subject: "Hi" },
            },
          ],
          else: [],
        },
      },
      { id: "wait", type: "flow.delay", config: { duration: "1m" } },
    ],
    ...(sections ? { sections } : {}),
  };
}

const delay = (id: string): Step => ({ id, type: "flow.delay", config: { duration: "1m" } });

/** Top-level `a`, `b`, `c`, `d` (Delays). */
function flat(sections?: Section[]): WorkflowDoc {
  return {
    id: "f",
    name: "F",
    trigger,
    steps: [delay("a"), delay("b"), delay("c"), delay("d")],
    ...(sections ? { sections } : {}),
  };
}

function ok(r: ApplyResult): Extract<ApplyResult, { ok: true }> {
  if (!r.ok) throw new Error(`apply failed: ${JSON.stringify(r.error)}`);
  return r;
}

function fail(r: ApplyResult): Extract<ApplyResult, { ok: false }> {
  if (r.ok) throw new Error("apply unexpectedly succeeded");
  return r;
}

const top = (d: WorkflowDoc) => d.steps.map((s) => s.id);
const step = (d: WorkflowDoc, id: string) => findStep(d, id)?.step as Step;

/** Runs `cmds`, whose last command fails, and checks the input doc is untouched. */
function atomic(d: WorkflowDoc, cmds: Command[]): void {
  const before = structuredClone(d);
  const r = fail(apply(d, [...cmds, { op: "removeStep", id: "nope" }], m));
  expect(r.error.index).toBe(cmds.length);
  expect(r.error.code).toBe("step.notFound");
  expect(d).toEqual(before);
}

describe("duplicateSteps", () => {
  test("copies the run right after last, named as copies; $n is the first copy", () => {
    const d = flat();
    const r = ok(apply(d, [{ op: "duplicateSteps", first: "b", last: "c" }], m));
    expect(top(r.doc)).toEqual(["a", "b", "c", "delay", "delay_2", "d"]);
    expect(step(r.doc, "delay").name).toBe("Delay (copy)");
    expect(step(r.doc, "delay_2").name).toBe("Delay (copy 2)");
    expect(r.ids).toEqual({ $1: "delay" });
    expect(r.changed).toContain("+ delay");
  });

  test("at places the copies elsewhere", () => {
    const r = ok(
      apply(flat(), [{ op: "duplicateSteps", first: "c", last: "d", at: { start: true } }], m),
    );
    expect(top(r.doc)).toEqual(["delay", "delay_2", "a", "b", "c", "d"]);
  });

  test("refs inside the copy point at the copies; refs outside stay", () => {
    const d: WorkflowDoc = {
      id: "t",
      name: "T",
      trigger,
      steps: [
        { id: "outside", type: "crm.getDeal", config: { dealId: "x" } },
        { id: "load", type: "crm.getDeal", config: { dealId: { $ref: "steps.outside.deal.id" } } },
        {
          id: "email",
          type: "crm.sendEmail",
          config: {
            to: { $ref: "steps.outside.deal.ownerId" },
            subject: { $tpl: "Stage {{steps.load.deal.stage}}" },
          },
        },
      ],
    };
    const r = ok(apply(d, [{ op: "duplicateSteps", first: "load", last: "email" }], m));
    expect(top(r.doc)).toEqual(["outside", "load", "email", "getDeal", "sendEmail"]);
    const copy = step(r.doc, "sendEmail");
    expect(copy.config.subject).toEqual({ $tpl: "Stage {{ steps.getDeal.deal.stage }}" });
    expect(copy.config.to).toEqual({ $ref: "steps.outside.deal.ownerId" });
    expect(step(r.doc, "getDeal").config.dealId).toEqual({ $ref: "steps.outside.deal.id" });
    expect(step(r.doc, "getDeal").name).toBe("Get deal (copy)");
    expect(copy.name).toBe("Send email (copy)");
  });

  test("copies a subtree with fresh IDs", () => {
    const r = ok(apply(doc(), [{ op: "duplicateSteps", first: "check", last: "check" }], m));
    expect(top(r.doc)).toEqual(["load", "check", "if", "wait"]);
    const copy = step(r.doc, "if");
    expect(copy.branches?.then?.map((s) => s.id)).toEqual(["sendEmail"]);
  });

  test("first/last accept $n", () => {
    const r = ok(
      apply(
        flat(),
        [
          { op: "addStep", at: { start: true }, type: "flow.stop" },
          { op: "duplicateSteps", first: "$1", last: "$1" },
        ],
        m,
      ),
    );
    expect(top(r.doc)).toEqual(["stop", "stop_2", "a", "b", "c", "d"]);
    expect(r.ids).toEqual({ $1: "stop", $2: "stop_2" });
  });

  test("a run in two lists fails with run.invalid", () => {
    const r = fail(apply(doc(), [{ op: "duplicateSteps", first: "load", last: "notify" }], m));
    expect(r.error.code).toBe("run.invalid");
  });

  test("atomic", () => {
    atomic(flat(), [{ op: "duplicateSteps", first: "a", last: "d" }]);
  });
});

describe("updateSteps", () => {
  test("the list form applies each update in order; the later one wins", () => {
    const r = ok(
      apply(
        doc(),
        [
          {
            op: "updateSteps",
            updates: [
              { id: "wait", set: { name: "First", color: "blue", note: "n" } },
              { id: "notify", config: { subject: "Hello", body: "b" }, set: { disabled: true } },
              { id: "wait", set: { name: "Second" }, config: { duration: "5m" } },
            ],
          },
        ],
        m,
      ),
    );
    expect(step(r.doc, "wait")).toEqual({
      id: "wait",
      type: "flow.delay",
      config: { duration: "5m" },
      name: "Second",
      color: "blue",
      note: "n",
    });
    expect(step(r.doc, "notify").config).toEqual({
      to: { $ref: "steps.load.deal.ownerId" },
      subject: "Hello",
      body: "b",
    });
    expect(step(r.doc, "notify").disabled).toBe(true);
  });

  test('set.name "" clears the name; note and color null remove them; config null removes a key', () => {
    const d = doc();
    d.steps[2] = { ...delay("wait"), name: "Wait", note: "x", color: "pink", disabled: true };
    const r = ok(
      apply(
        d,
        [
          {
            op: "updateSteps",
            updates: [
              {
                id: "wait",
                set: { name: "", note: null, color: null, disabled: false },
                config: { duration: null },
              },
            ],
          },
        ],
        m,
      ),
    );
    expect(step(r.doc, "wait")).toEqual({ id: "wait", type: "flow.delay", config: {} });
  });

  test("an update that changes nothing is a no-op (toBe)", () => {
    const d = doc();
    const r = ok(
      apply(
        d,
        [
          {
            op: "updateSteps",
            updates: [{ id: "wait", set: { name: "", color: null }, config: { duration: "1m" } }],
          },
        ],
        m,
      ),
    );
    expect(r.doc).toBe(d);
  });

  test("an unknown ID fails with step.notFound at its path", () => {
    const r = fail(
      apply(
        doc(),
        [
          {
            op: "updateSteps",
            updates: [
              { id: "wait", set: { name: "W" } },
              { id: "nope", set: { name: "X" } },
            ],
          },
        ],
        m,
      ),
    );
    expect(r.error.code).toBe("step.notFound");
    expect(r.error.path).toBe("commands[0].updates[1].id");
  });

  test("a bad colour in trusted mode fails at the update's path", () => {
    const r = fail(
      apply(
        doc(),
        [
          {
            op: "updateSteps",
            updates: [{ id: "wait" }, { id: "wait", set: { color: "red" as "blue" } }],
          },
        ],
        m,
        { trusted: true },
      ),
    );
    expect(r.error.code).toBe("command.invalid");
    expect(r.error.path).toBe("commands[0].updates[1].set.color");
  });

  test("ids accept $n, and config values resolve placeholders", () => {
    const r = ok(
      apply(
        doc(),
        [
          { op: "addStep", at: { after: "wait" }, type: "crm.getDeal" },
          {
            op: "updateSteps",
            updates: [
              { id: "$1", set: { name: "Reload" } },
              { id: "notify", config: { subject: { $tpl: "{{steps.$1.deal.stage}}" } } },
            ],
          },
        ],
        m,
      ),
    );
    expect(step(r.doc, "getDeal").name).toBe("Reload");
    expect(step(r.doc, "notify").config.subject).toEqual({
      $tpl: "{{steps.getDeal.deal.stage}}",
    });
  });

  test("the selector form updates every match", () => {
    const r = ok(
      apply(
        flat(),
        [
          {
            op: "updateSteps",
            where: { type: "flow.delay" },
            set: { color: "green" },
            config: { duration: "2m" },
            expect: 4,
          },
        ],
        m,
      ),
    );
    for (const s of r.doc.steps) {
      expect(s.color).toBe("green");
      expect(s.config.duration).toBe("2m");
    }
  });

  test("the selector form fails with expect.mismatch and the matched IDs", () => {
    const d = flat();
    const r = fail(
      apply(
        d,
        [{ op: "updateSteps", where: { type: "flow.delay" }, set: { color: "green" }, expect: 3 }],
        m,
      ),
    );
    expect(r.error.code).toBe("expect.mismatch");
    expect(r.error.path).toBe("commands[0].expect");
    expect(r.error.hint).toEqual({ matched: ["a", "b", "c", "d"] });
  });

  test("a mismatch hint lists at most 100 IDs and counts the rest", () => {
    const d = flatDoc(150);
    const r = fail(apply(d, [{ op: "removeSteps", where: {}, expect: 1 }], m));
    const hint = r.error.hint as { matched: string[]; more: number };
    expect(hint.matched).toHaveLength(100);
    expect(hint.matched[0]).toBe("step_1");
    expect(hint.more).toBe(50);
  });

  test("expect: 0 with no match is a no-op (toBe)", () => {
    const d = flat();
    const r = ok(
      apply(
        d,
        [{ op: "updateSteps", where: { type: "crm.sendEmail" }, set: { name: "x" }, expect: 0 }],
        m,
      ),
    );
    expect(r.doc).toBe(d);
  });

  test("where.within accepts $n", () => {
    const r = ok(
      apply(
        doc(),
        [
          {
            op: "wrapSteps",
            first: "wait",
            last: "wait",
            in: { type: "flow.if", branch: "then", config: { value: true } },
          },
          {
            op: "updateSteps",
            where: { within: { stepId: "$1" } },
            set: { name: "In" },
            expect: 1,
          },
        ],
        m,
      ),
    );
    expect(step(r.doc, "wait").name).toBe("In");
  });

  test("where naming a missing step fails with step.notFound", () => {
    const r = fail(
      apply(
        doc(),
        [{ op: "updateSteps", where: { within: { stepId: "nope" } }, set: {}, expect: 0 }],
        m,
      ),
    );
    expect(r.error.code).toBe("step.notFound");
    expect(r.error.path).toBe("commands[0].where.within.stepId");
  });

  test("where naming a missing section fails with section.notFound", () => {
    const r = fail(
      apply(doc(), [{ op: "updateSteps", where: { section: "nope" }, set: {}, expect: 0 }], m),
    );
    expect(r.error.code).toBe("section.notFound");
    expect(r.error.path).toBe("commands[0].where.section");
  });

  test("atomic", () => {
    atomic(doc(), [{ op: "updateSteps", updates: [{ id: "wait", set: { name: "W" } }] }]);
    atomic(flat(), [
      { op: "updateSteps", where: { type: "flow.delay" }, set: { name: "W" }, expect: 4 },
    ]);
  });
});

describe("replaceInConfig", () => {
  function mail(): WorkflowDoc {
    return {
      id: "t",
      name: "T",
      trigger: { type: "crm.dealStuckInStage", config: { stage: "old" } },
      steps: [
        { id: "load", type: "crm.getDeal", config: { dealId: { $ref: "steps.old.id" } } },
        {
          id: "email",
          type: "crm.sendEmail",
          config: {
            to: "old@example.com",
            subject: { $tpl: "The old deal {{steps.old.stage}}, old" },
            body: { $ref: "steps.old.body" },
            extra: ["old", { nested: "an old one" }, 3],
          },
        },
        { id: "other", type: "crm.sendEmail", config: { to: "x", subject: "old" } },
      ],
    };
  }

  test("replaces in literals and template text, not $refs or the trigger", () => {
    const d = mail();
    const r = ok(apply(d, [{ op: "replaceInConfig", find: "old", replace: "new", expect: 2 }], m));
    expect(step(r.doc, "email").config).toEqual({
      to: "new@example.com",
      subject: { $tpl: "The new deal {{steps.old.stage}}, new" },
      body: { $ref: "steps.old.body" },
      extra: ["new", { nested: "an new one" }, 3],
    });
    expect(step(r.doc, "other").config.subject).toBe("new");
    expect(step(r.doc, "load")).toBe(step(d, "load"));
    expect(r.doc.trigger).toEqual(d.trigger);
  });

  test("where limits the steps; expect counts steps with a replacement", () => {
    const r = ok(
      apply(
        mail(),
        [
          {
            op: "replaceInConfig",
            find: "old",
            replace: "new",
            where: { nameContains: "email", configHas: "extra" },
            expect: 1,
          },
        ],
        m,
      ),
    );
    expect(step(r.doc, "email").config.to).toBe("new@example.com");
    expect(step(r.doc, "other").config.subject).toBe("old");
  });

  test("a different count fails with expect.mismatch and the matched IDs", () => {
    const r = fail(
      apply(mail(), [{ op: "replaceInConfig", find: "old", replace: "x", expect: 1 }], m),
    );
    expect(r.error.code).toBe("expect.mismatch");
    expect(r.error.hint).toEqual({ matched: ["email", "other"] });
  });

  test("expect: 0 with no match is a no-op (toBe)", () => {
    const d = mail();
    const r = ok(apply(d, [{ op: "replaceInConfig", find: "zzz", replace: "x", expect: 0 }], m));
    expect(r.doc).toBe(d);
  });

  test('find: "" fails with command.invalid (also trusted)', () => {
    for (const trusted of [false, true]) {
      const r = fail(
        apply(mail(), [{ op: "replaceInConfig", find: "", replace: "x", expect: 0 }], m, {
          trusted,
        }),
      );
      expect(r.error.code).toBe("command.invalid");
      expect(r.error.path).toBe("commands[0].find");
    }
  });

  test("where.within accepts $n", () => {
    const r = ok(
      apply(
        mail(),
        [
          {
            op: "wrapSteps",
            first: "other",
            last: "other",
            in: { type: "flow.if", branch: "else", config: { value: true } },
          },
          {
            op: "replaceInConfig",
            find: "old",
            replace: "new",
            where: { within: { stepId: "$1", branch: "else" } },
            expect: 1,
          },
        ],
        m,
      ),
    );
    expect(step(r.doc, "other").config.subject).toBe("new");
    expect(step(r.doc, "email").config.to).toBe("old@example.com");
  });

  test("atomic", () => {
    atomic(mail(), [{ op: "replaceInConfig", find: "old", replace: "new", expect: 2 }]);
  });
});

describe("moveSteps", () => {
  test("moves the run as a block; to is resolved after removal", () => {
    const r = ok(
      apply(flat(), [{ op: "moveSteps", first: "b", last: "c", to: { after: "d" } }], m),
    );
    expect(top(r.doc)).toEqual(["a", "d", "b", "c"]);
  });

  test("moves into a branch", () => {
    const r = ok(
      apply(
        doc(),
        [
          {
            op: "moveSteps",
            first: "load",
            last: "load",
            to: { in: { stepId: "check", branch: "else" } },
          },
        ],
        m,
      ),
    );
    expect(top(r.doc)).toEqual(["check", "wait"]);
    expect(step(r.doc, "check").branches?.else?.map((s) => s.id)).toEqual(["load"]);
  });

  test("moving to where it already is is a no-op (toBe)", () => {
    const d = flat();
    for (const to of [{ after: "c" }, { before: "b" }, { after: "a" }, { before: "d" }]) {
      const r = ok(apply(d, [{ op: "moveSteps", first: "b", last: "c", to }], m));
      expect(r.doc).toBe(d);
    }
  });

  test("a target inside the run's subtree fails with move.intoSelf", () => {
    for (const to of [
      { in: { stepId: "check", branch: "else" } },
      { after: "notify" },
      { before: "check" },
    ]) {
      const r = fail(apply(doc(), [{ op: "moveSteps", first: "load", last: "check", to }], m));
      expect(r.error.code).toBe("move.intoSelf");
    }
  });

  test("an invalid run fails with run.invalid", () => {
    const r = fail(
      apply(flat(), [{ op: "moveSteps", first: "c", last: "b", to: { start: true } }], m),
    );
    expect(r.error.code).toBe("run.invalid");
  });

  test("first/last accept $n", () => {
    const r = ok(
      apply(
        flat(),
        [
          { op: "addStep", at: { start: true }, type: "flow.stop" },
          { op: "moveSteps", first: "$1", last: "a", to: { after: "d" } },
        ],
        m,
      ),
    );
    expect(top(r.doc)).toEqual(["b", "c", "d", "stop", "a"]);
  });

  test("atomic", () => {
    atomic(flat(), [{ op: "moveSteps", first: "a", last: "b", to: { after: "d" } }]);
  });
});

describe("removeSteps", () => {
  test("the ids form removes each, skipping descendants of removed steps", () => {
    const r = ok(
      apply(doc(), [{ op: "removeSteps", ids: ["notify", "check", "wait", "check"] }], m),
    );
    expect(top(r.doc)).toEqual(["load"]);
    expect(r.changed).toContain("- check");
    expect(r.changed).toContain("- notify");
  });

  test("an unknown ID fails with step.notFound at its path", () => {
    const r = fail(apply(doc(), [{ op: "removeSteps", ids: ["wait", "nope"] }], m));
    expect(r.error.code).toBe("step.notFound");
    expect(r.error.path).toBe("commands[0].ids[1]");
  });

  test("the run form removes first…last", () => {
    const r = ok(apply(flat(), [{ op: "removeSteps", first: "b", last: "c" }], m));
    expect(top(r.doc)).toEqual(["a", "d"]);
  });

  test("the where form removes the matches, skipping descendants", () => {
    const r = ok(apply(doc(), [{ op: "removeSteps", where: {}, expect: 4 }], m));
    expect(r.doc.steps).toEqual([]);
  });

  test("the where form fails with expect.mismatch and the matched IDs", () => {
    const r = fail(
      apply(doc(), [{ op: "removeSteps", where: { type: "crm.sendEmail" }, expect: 2 }], m),
    );
    expect(r.error.code).toBe("expect.mismatch");
    expect(r.error.hint).toEqual({ matched: ["notify"] });
  });

  test("expect: 0 with no match is a no-op (toBe)", () => {
    const d = doc();
    const r = ok(apply(d, [{ op: "removeSteps", where: { type: "flow.stop" }, expect: 0 }], m));
    expect(r.doc).toBe(d);
  });

  test("dangling refs are reported in issues.added", () => {
    const r = ok(apply(doc(), [{ op: "removeSteps", ids: ["load"] }], m));
    expect(r.issues.added.some((i) => i.stepId === "notify" && i.code.startsWith("ref."))).toBe(
      true,
    );
  });

  test("ids accept $n", () => {
    const r = ok(
      apply(
        flat(),
        [
          { op: "addStep", at: { start: true }, type: "flow.stop" },
          { op: "removeSteps", ids: ["$1", "a"] },
        ],
        m,
      ),
    );
    expect(top(r.doc)).toEqual(["b", "c", "d"]);
    expect(r.ids).toEqual({ $1: "stop" });
  });

  test("atomic", () => {
    atomic(flat(), [{ op: "removeSteps", ids: ["a"] }]);
    atomic(flat(), [{ op: "removeSteps", first: "a", last: "c" }]);
    atomic(flat(), [{ op: "removeSteps", where: { type: "flow.delay" }, expect: 4 }]);
  });
});

describe("wrapSteps", () => {
  test("puts the run in the branch of a new step in its place; $n is the wrapper", () => {
    const r = ok(
      apply(
        flat(),
        [
          {
            op: "wrapSteps",
            first: "b",
            last: "c",
            in: { type: "flow.if", branch: "else", config: { value: false } },
          },
        ],
        m,
      ),
    );
    expect(top(r.doc)).toEqual(["a", "if", "d"]);
    const wrapper = step(r.doc, "if");
    expect(wrapper.config).toEqual({ value: false });
    expect(wrapper.branches?.else?.map((s) => s.id)).toEqual(["b", "c"]);
    expect(wrapper.branches?.then).toEqual([]);
    expect(r.ids).toEqual({ $1: "if" });
  });

  test("a branch the type doesn't declare fails with branch.unknown", () => {
    const r = fail(
      apply(
        flat(),
        [{ op: "wrapSteps", first: "b", last: "c", in: { type: "flow.if", branch: "nope" } }],
        m,
      ),
    );
    expect(r.error.code).toBe("branch.unknown");
    expect(r.error.path).toBe("commands[0].in.branch");
    expect(r.error.hint).toEqual({ branches: ["then", "else"] });
    const none = fail(
      apply(
        flat(),
        [{ op: "wrapSteps", first: "b", last: "c", in: { type: "flow.delay", branch: "x" } }],
        m,
      ),
    );
    expect(none.error.code).toBe("branch.unknown");
  });

  test("an unknown type fails with node.unknown", () => {
    const r = fail(
      apply(
        flat(),
        [{ op: "wrapSteps", first: "b", last: "c", in: { type: "flow.iff", branch: "then" } }],
        m,
      ),
    );
    expect(r.error.code).toBe("node.unknown");
    expect(r.error.path).toBe("commands[0].in.type");
  });

  test("first/last accept $n, and the wrapper's $n works later", () => {
    const r = ok(
      apply(
        flat(),
        [
          { op: "addStep", at: { start: true }, type: "flow.stop" },
          { op: "wrapSteps", first: "$1", last: "a", in: { type: "flow.forEach", branch: "body" } },
          { op: "renameStep", id: "$2", name: "Loop" },
        ],
        m,
      ),
    );
    expect(top(r.doc)).toEqual(["forEach", "b", "c", "d"]);
    expect(step(r.doc, "forEach").branches?.body?.map((s) => s.id)).toEqual(["stop", "a"]);
    expect(step(r.doc, "forEach").name).toBe("Loop");
  });

  test("atomic", () => {
    atomic(flat(), [
      { op: "wrapSteps", first: "a", last: "b", in: { type: "flow.if", branch: "then" } },
    ]);
  });
});

describe("unwrapStep", () => {
  function branchy(): WorkflowDoc {
    const d = doc();
    d.steps[1] = {
      ...(d.steps[1] as Step),
      branches: {
        // biome-ignore lint/suspicious/noThenProperty: a branch ID, not a thenable
        then: [{ id: "notify", type: "crm.sendEmail", config: { to: "x", subject: "y" } }],
        else: [delay("e1"), { id: "e2", type: "flow.stop", config: {} }],
      },
    };
    return d;
  }

  test("keeping else lifts its steps in order and removes the others", () => {
    const r = ok(apply(branchy(), [{ op: "unwrapStep", id: "check", keep: "else" }], m));
    expect(top(r.doc)).toEqual(["load", "e1", "e2", "wait"]);
    expect(findStep(r.doc, "notify")).toBeUndefined();
    expect(r.changed).toContain("- check");
    expect(r.changed).toContain("- notify");
  });

  test("a step without branches fails with command.invalid", () => {
    const r = fail(apply(doc(), [{ op: "unwrapStep", id: "wait", keep: "then" }], m));
    expect(r.error.code).toBe("command.invalid");
    expect(r.error.path).toBe("commands[0].id");
  });

  test("keep must be one of its branches", () => {
    const r = fail(apply(doc(), [{ op: "unwrapStep", id: "check", keep: "nope" }], m));
    expect(r.error.code).toBe("branch.unknown");
    expect(r.error.path).toBe("commands[0].keep");
    expect(r.error.hint).toEqual({ branches: ["then", "else"] });
  });

  test("id accepts $n: wrap then unwrap round-trips", () => {
    const d = flat();
    const r = ok(
      apply(
        d,
        [
          { op: "wrapSteps", first: "b", last: "c", in: { type: "flow.if", branch: "then" } },
          { op: "unwrapStep", id: "$1", keep: "then" },
        ],
        m,
      ),
    );
    expect(r.doc).toEqual(d);
  });

  test("atomic", () => {
    atomic(branchy(), [{ op: "unwrapStep", id: "check", keep: "then" }]);
  });
});

describe("schemas", () => {
  test("whereSchema is strict", () => {
    expect(whereSchema.safeParse({ type: "x", within: { stepId: "a" } }).success).toBe(true);
    expect(whereSchema.safeParse({ typo: "x" }).success).toBe(false);
    expect(whereSchema.safeParse({ within: { stepId: "a", extra: 1 } }).success).toBe(false);
  });

  test("selector commands require expect; unknown keys fail", () => {
    const s = commandSchema(m);
    expect(s.safeParse({ op: "removeSteps", where: {} }).success).toBe(false);
    expect(s.safeParse({ op: "removeSteps", where: {}, expect: 0 }).success).toBe(true);
    expect(
      s.safeParse({ op: "updateSteps", where: {}, expect: 1, set: { nme: "x" } }).success,
    ).toBe(false);
    expect(s.safeParse({ op: "replaceInConfig", find: "a", replace: "b" }).success).toBe(false);
    const r = fail(apply(flat(), [{ op: "removeSteps", where: {} } as Command], m));
    expect(r.error.code).toBe("command.invalid");
    expect(r.error.path).toBe("commands[0].expect");
  });
});
