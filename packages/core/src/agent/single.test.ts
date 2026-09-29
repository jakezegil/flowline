import { describe, expect, test } from "vitest";
import { findStep, walkSteps } from "../tree";
import type { Manifest, NodeManifest, Step, TriggerManifest, WorkflowDoc } from "../types";
import { UI_META_KEY } from "../ui";
import { apply } from "./apply";
import { commandSchema } from "./command-schema";
import type { ApplyResult, Command } from "./commands";
import { richManifest } from "./fixtures";

const countNode: NodeManifest = {
  type: "util.count",
  plugin: "flow",
  name: "Count",
  input: {
    type: "object",
    properties: { times: { type: "number" }, label: { type: "string", default: "n" } },
    required: ["times"],
  },
  output: { kind: "schema", schema: { type: "object", properties: {} } },
  branches: { kind: "none" },
};

/** A node with a code field (`widget: "code"`), like a Transform. */
const codeNode: NodeManifest = {
  type: "util.transform",
  plugin: "flow",
  name: "Transform",
  input: {
    type: "object",
    properties: { code: { type: "string", [UI_META_KEY]: { widget: "code" } } },
  },
  output: { kind: "schema", schema: {} },
  branches: { kind: "none" },
};

const manualTrigger: TriggerManifest = {
  type: "util.manual",
  plugin: "flow",
  name: "Manual",
  kind: "manual",
  config: {
    type: "object",
    properties: { label: { type: "string", default: "go" }, n: { type: "number" } },
  },
  payload: { kind: "schema", schema: { type: "object", properties: {} } },
};

const base = richManifest();
const m: Manifest = {
  ...base,
  nodes: [...base.nodes, countNode, codeNode],
  triggers: [...base.triggers, manualTrigger],
};

/**
 * `load` (getDeal), `check` (If) with `notify` in `then`, `wait` (Delay), and `sendEmail` (a
 * generated ID). `notify` reads `load` in a template; the output reads `sendEmail`.
 */
function doc(): WorkflowDoc {
  return {
    id: "t",
    name: "T",
    trigger: { type: "crm.dealStuckInStage", config: { stage: "proposal" } },
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
              config: { to: "a@b.c", subject: { $tpl: "Deal {{ steps.load.deal.id }}" } },
            },
          ],
          else: [],
        },
      },
      { id: "wait", type: "flow.delay", config: { duration: "1m" } },
      { id: "sendEmail", type: "crm.sendEmail", config: { to: "x@y.z", subject: "S" } },
    ],
    output: { messageId: { $ref: "steps.sendEmail.messageId" } },
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

const step = (d: WorkflowDoc, id: string) => findStep(d, id)?.step as Step;
const ids = (d: WorkflowDoc) => {
  const out: string[] = [];
  walkSteps(d, (s) => out.push(s.id));
  return out;
};
const addCount: Command = {
  op: "addStep",
  at: { after: "load" },
  type: "util.count",
  config: { times: 1 },
};

interface Row {
  op: string;
  /** The normal case, run on `doc()`. */
  normal: Command[];
  check: (after: WorkflowDoc, r: Extract<ApplyResult, { ok: true }>) => void;
  /** An unknown target: the error code and path. `null` when the command has no target. */
  notFound: { cmd: Command; code: string; path: string } | null;
  /** A command addressing `$1`, the step `addCount` created. `null` when there is no target. */
  dollar: {
    cmd: Command;
    check: (after: WorkflowDoc, r: Extract<ApplyResult, { ok: true }>) => void;
  } | null;
}

const rows: Row[] = [
  {
    op: "duplicateStep",
    normal: [{ op: "duplicateStep", id: "notify" }],
    check: (d, r) => {
      const then = step(d, "check").branches?.then as Step[];
      expect(then.map((s) => s.id)).toEqual(["notify", "sendEmail_2"]);
      expect(step(d, "sendEmail_2").name).toBe("Send email (copy)");
      expect(step(d, "sendEmail_2").config).toEqual(step(d, "notify").config);
      expect(r.ids).toEqual({ $1: "sendEmail_2" });
    },
    notFound: { cmd: { op: "duplicateStep", id: "nope" }, code: "step.notFound", path: "id" },
    dollar: {
      cmd: { op: "duplicateStep", id: "$1" },
      check: (d, r) => {
        expect(r.ids).toEqual({ $1: "count", $2: "count_2" });
        expect(step(d, "count_2").name).toBe("Count (copy)");
      },
    },
  },
  {
    op: "renameStep",
    normal: [{ op: "renameStep", id: "load", name: "  Load it " }],
    check: (d) => expect(step(d, "load").name).toBe("Load it"),
    notFound: {
      cmd: { op: "renameStep", id: "nope", name: "x" },
      code: "step.notFound",
      path: "id",
    },
    dollar: {
      cmd: { op: "renameStep", id: "$1", name: "Counter" },
      check: (d) => expect(step(d, "count").name).toBe("Counter"),
    },
  },
  {
    op: "renameStepId",
    normal: [{ op: "renameStepId", id: "load", newId: "fetch" }],
    check: (d, r) => {
      expect(step(d, "fetch").type).toBe("crm.getDeal");
      expect(findStep(d, "load")).toBeUndefined();
      expect(step(d, "notify").config.subject).toEqual({ $tpl: "Deal {{ steps.fetch.deal.id }}" });
      expect(r.renamed).toEqual({ load: "fetch" });
      expect(r.ids).toEqual({ $1: "fetch" });
    },
    notFound: {
      cmd: { op: "renameStepId", id: "nope", newId: "x" },
      code: "step.notFound",
      path: "id",
    },
    dollar: {
      cmd: { op: "renameStepId", id: "$1", newId: "counter" },
      check: (d, r) => {
        expect(step(d, "counter").type).toBe("util.count");
        expect(r.ids).toEqual({ $1: "counter", $2: "counter" });
      },
    },
  },
  {
    op: "setType",
    normal: [{ op: "setType", id: "sendEmail", type: "crm.getDeal" }],
    check: (d, r) => {
      // A generated ID is regenerated, and references to it follow.
      expect(findStep(d, "sendEmail")).toBeUndefined();
      expect(step(d, "getDeal")).toEqual({ id: "getDeal", type: "crm.getDeal", config: {} });
      expect(d.output).toEqual({ messageId: { $ref: "steps.getDeal.messageId" } });
      expect(r.renamed).toEqual({ sendEmail: "getDeal" });
      expect(r.ids).toEqual({ $1: "getDeal" });
    },
    notFound: {
      cmd: { op: "setType", id: "nope", type: "crm.getDeal" },
      code: "step.notFound",
      path: "id",
    },
    dollar: {
      cmd: { op: "setType", id: "$1", type: "crm.getDeal" },
      check: (d, r) => {
        expect(step(d, "getDeal").type).toBe("crm.getDeal");
        expect(r.ids).toEqual({ $1: "getDeal", $2: "getDeal" });
        expect(r.renamed).toEqual({ count: "getDeal" });
      },
    },
  },
  {
    op: "setDisabled",
    normal: [{ op: "setDisabled", id: "wait", disabled: true }],
    check: (d) => expect(step(d, "wait").disabled).toBe(true),
    notFound: {
      cmd: { op: "setDisabled", id: "nope", disabled: true },
      code: "step.notFound",
      path: "id",
    },
    dollar: {
      cmd: { op: "setDisabled", id: "$1", disabled: true },
      check: (d) => expect(step(d, "count").disabled).toBe(true),
    },
  },
  {
    op: "setNote",
    normal: [{ op: "setNote", id: "wait", note: "Why we wait" }],
    check: (d) => expect(step(d, "wait").note).toBe("Why we wait"),
    notFound: { cmd: { op: "setNote", id: "nope", note: "x" }, code: "step.notFound", path: "id" },
    dollar: {
      cmd: { op: "setNote", id: "$1", note: "n" },
      check: (d) => expect(step(d, "count").note).toBe("n"),
    },
  },
  {
    op: "setColor",
    normal: [{ op: "setColor", id: "wait", color: "pink" }],
    check: (d) => expect(step(d, "wait").color).toBe("pink"),
    notFound: {
      cmd: { op: "setColor", id: "nope", color: "pink" },
      code: "step.notFound",
      path: "id",
    },
    dollar: {
      cmd: { op: "setColor", id: "$1", color: "green" },
      check: (d) => expect(step(d, "count").color).toBe("green"),
    },
  },
  {
    op: "setTrigger",
    normal: [{ op: "setTrigger", type: "util.manual", config: { n: 2 } }],
    check: (d) => expect(d.trigger).toEqual({ type: "util.manual", config: { label: "go", n: 2 } }),
    notFound: {
      cmd: { op: "setTrigger", type: "nope.nope" },
      code: "trigger.unknown",
      path: "type",
    },
    dollar: {
      cmd: {
        op: "setTrigger",
        type: "crm.dealStuckInStage",
        config: { stage: { $tpl: "{{ steps.$1.times }}" } },
      },
      check: (d, r) => {
        expect(d.trigger.config.stage).toEqual({ $tpl: "{{ steps.count.times }}" });
        expect(r.ids).toEqual({ $1: "count" });
      },
    },
  },
  {
    op: "setTriggerConfig",
    normal: [{ op: "setTriggerConfig", key: "stage", value: "won" }],
    check: (d) => expect(d.trigger.config).toEqual({ stage: "won" }),
    notFound: null,
    dollar: {
      cmd: { op: "setTriggerConfig", config: { stage: { $ref: "steps.$1.times" } } },
      check: (d) => expect(d.trigger.config.stage).toEqual({ $ref: "steps.count.times" }),
    },
  },
  {
    op: "setOutput",
    normal: [{ op: "setOutput", key: "deal", value: { $ref: "steps.load.deal" } }],
    check: (d) =>
      expect(d.output).toEqual({
        messageId: { $ref: "steps.sendEmail.messageId" },
        deal: { $ref: "steps.load.deal" },
      }),
    notFound: null,
    dollar: {
      cmd: { op: "setOutput", key: "n", value: { $ref: "steps.$1.times" } },
      check: (d) => expect(d.output?.n).toEqual({ $ref: "steps.count.times" }),
    },
  },
  {
    op: "renameWorkflow",
    normal: [{ op: "renameWorkflow", name: " Deal flow " }],
    check: (d) => expect(d.name).toBe("Deal flow"),
    notFound: null,
    dollar: null,
  },
];

describe.each(rows)("$op", (row) => {
  test("normal case", () => {
    const d = doc();
    const before = structuredClone(d);
    const r = ok(apply(d, row.normal, m));
    row.check(r.doc, r);
    expect(d).toEqual(before);
  });

  test("the same result in trusted mode", () => {
    const a = ok(apply(doc(), row.normal, m));
    const b = ok(apply(doc(), row.normal, m, { trusted: true, report: false }));
    expect(b.doc).toEqual(a.doc);
    expect(b.ids).toEqual(a.ids);
    expect(b.renamed).toEqual(a.renamed);
  });

  test("atomic: a failing next command leaves the input deep-equal to its clone", () => {
    const d = doc();
    const before = structuredClone(d);
    const r = fail(apply(d, [...row.normal, { op: "removeStep", id: "nope" }], m));
    expect(r.error.index).toBe(row.normal.length);
    expect(r.error.path).toBe(`commands[${row.normal.length}].id`);
    expect(d).toEqual(before);
  });
});

// Rows without a target (setTriggerConfig, setOutput, renameWorkflow) have no not-found case,
// and renameWorkflow has no `$n` case: they are left out of these tables, not passed vacuously.
const withTarget = rows.flatMap((r) => (r.notFound ? [{ ...r, notFound: r.notFound }] : []));
const withDollar = rows.flatMap((r) => (r.dollar ? [{ ...r, dollar: r.dollar }] : []));

test("the tables cover the expected ops", () => {
  expect(withTarget.map((r) => r.op)).toEqual([
    "duplicateStep",
    "renameStep",
    "renameStepId",
    "setType",
    "setDisabled",
    "setNote",
    "setColor",
    "setTrigger",
  ]);
  expect(withDollar.map((r) => r.op)).toEqual(rows.map((r) => r.op).slice(0, -1));
});

describe.each(withTarget)("$op: an unknown target", (row) => {
  test("fails and leaves the input untouched", () => {
    const d = doc();
    const before = structuredClone(d);
    const r = fail(apply(d, [row.notFound.cmd], m));
    expect(r.error.code).toBe(row.notFound.code);
    expect(r.error.path).toBe(`commands[0].${row.notFound.path}`);
    expect(r.error.hint).toBeDefined();
    expect(d).toEqual(before);
  });
});

describe.each(withDollar)("$op: $1", (row) => {
  test("addresses the step an earlier command created", () => {
    const r = ok(apply(doc(), [addCount, row.dollar.cmd], m));
    row.dollar.check(r.doc, r);
  });
});

describe("no-op identity", () => {
  const annotated = (): WorkflowDoc => {
    const d = doc();
    d.steps[2] = { ...(d.steps[2] as Step), name: "Wait", note: "N", color: "blue" };
    return d;
  };
  const cases: [string, Command][] = [
    ["renameStep to the same name", { op: "renameStep", id: "wait", name: "Wait" }],
    ["renameStep '' on an unnamed step", { op: "renameStep", id: "load", name: "" }],
    ["renameStepId to the same ID", { op: "renameStepId", id: "wait", newId: "wait" }],
    ["setType to the same type", { op: "setType", id: "wait", type: "flow.delay" }],
    ["setDisabled to the current value", { op: "setDisabled", id: "wait", disabled: false }],
    ["setNote with the same text", { op: "setNote", id: "wait", note: "N" }],
    ["setNote(null) on a step with no note", { op: "setNote", id: "load", note: null }],
    ["setNote('') on a step with no note", { op: "setNote", id: "load", note: "" }],
    ["setColor with the same colour", { op: "setColor", id: "wait", color: "blue" }],
    ["setColor(null) on a step with no colour", { op: "setColor", id: "load", color: null }],
    [
      "setTrigger with the same type and no config",
      { op: "setTrigger", type: "crm.dealStuckInStage" },
    ],
    [
      "setTrigger with the same type and an equal config",
      { op: "setTrigger", type: "crm.dealStuckInStage", config: { stage: "proposal" } },
    ],
    [
      "setTriggerConfig with an equal value",
      { op: "setTriggerConfig", key: "stage", value: "proposal" },
    ],
    ["setTriggerConfig removing an absent key", { op: "setTriggerConfig", key: "x", value: null }],
    [
      "setOutput with an equal value",
      { op: "setOutput", key: "messageId", value: { $ref: "steps.sendEmail.messageId" } },
    ],
    ["setOutput removing an absent key", { op: "setOutput", config: { nope: null } }],
    ["renameWorkflow with the same name", { op: "renameWorkflow", name: "T" }],
  ];
  test.each(cases)("%s", (_, cmd) => {
    const d = annotated();
    expect(apply(d, [cmd], m).ok && ok(apply(d, [cmd], m)).doc).toBe(d);
    expect(ok(apply(d, [cmd], m, { trusted: true, report: false })).doc).toBe(d);
  });
});

describe("duplicateStep names", () => {
  test('twice on "Send email" gives "(copy)" then "(copy 2)", and a copy of a copy "(copy 3)"', () => {
    const r = ok(
      apply(
        doc(),
        [
          { op: "duplicateStep", id: "notify" },
          { op: "duplicateStep", id: "notify" },
          { op: "duplicateStep", id: "$1" },
        ],
        m,
      ),
    );
    expect(step(r.doc, r.ids.$1 as string).name).toBe("Send email (copy)");
    expect(step(r.doc, r.ids.$2 as string).name).toBe("Send email (copy 2)");
    expect(step(r.doc, r.ids.$3 as string).name).toBe("Send email (copy 3)");
    expect(step(r.doc, "notify").name).toBeUndefined();
  });

  test("a duplicated subtree gets fresh IDs, refs inside remapped, refs outside kept", () => {
    const d = doc();
    const check = d.steps[1] as Step;
    const notify = check.branches?.then?.[0] as Step;
    notify.config.body = { $tpl: "Matched: {{ steps.check.matched }}" };
    const r = ok(apply(d, [{ op: "duplicateStep", id: "check" }], m));
    expect(r.ids.$1).toBe("if");
    expect(new Set(ids(r.doc)).size).toBe(ids(r.doc).length);
    expect(step(r.doc, "if").name).toBe("If (copy)");
    const copy = step(r.doc, "if").branches?.then?.[0] as Step;
    expect(copy.id).toBe("sendEmail_2");
    // The ref to the copied `check` points at the copy; the ref to `load` (outside) is kept.
    expect(copy.config.body).toEqual({ $tpl: "Matched: {{ steps.if.matched }}" });
    expect(copy.config.subject).toEqual({ $tpl: "Deal {{ steps.load.deal.id }}" });
    // The original is untouched.
    expect(step(r.doc, "notify").config.body).toEqual({
      $tpl: "Matched: {{ steps.check.matched }}",
    });
  });
});

describe("renameStep", () => {
  test('"" (or blank) clears the name', () => {
    const d = doc();
    d.steps[0] = { ...(d.steps[0] as Step), name: "Load" };
    expect(step(ok(apply(d, [{ op: "renameStep", id: "load", name: "" }], m)).doc, "load")).toEqual(
      doc().steps[0],
    );
    expect(
      step(ok(apply(d, [{ op: "renameStep", id: "load", name: "   " }], m)).doc, "load").name,
    ).toBeUndefined();
  });
});

describe("renameStepId", () => {
  test("a taken ID fails with id.taken and a suggestion", () => {
    const r = fail(apply(doc(), [{ op: "renameStepId", id: "load", newId: "wait" }], m));
    expect(r.error).toMatchObject({
      code: "id.taken",
      path: "commands[0].newId",
      hint: { suggested: "wait_2" },
    });
  });

  test("an invalid ID fails with id.invalid", () => {
    const r = fail(apply(doc(), [{ op: "renameStepId", id: "load", newId: "9x" }], m));
    expect(r.error).toMatchObject({
      code: "id.invalid",
      path: "commands[0].newId",
      hint: { suggested: "_9x" },
    });
  });

  test("renaming twice records one old → new entry, and $n follows", () => {
    const r = ok(
      apply(
        doc(),
        [
          { op: "renameStepId", id: "load", newId: "a" },
          { op: "renameStepId", id: "$1", newId: "b" },
          { op: "setNote", id: "$1", note: "x" },
        ],
        m,
      ),
    );
    expect(r.renamed).toEqual({ load: "b" });
    expect(r.ids).toEqual({ $1: "b", $2: "b" });
    expect(step(r.doc, "b").note).toBe("x");
  });

  test("renaming back drops the entry", () => {
    const r = ok(
      apply(
        doc(),
        [
          { op: "renameStepId", id: "load", newId: "a" },
          { op: "renameStepId", id: "a", newId: "load" },
        ],
        m,
      ),
    );
    expect(r.renamed).toEqual({});
  });

  test("a section endpoint follows the rename", () => {
    const d = {
      ...doc(),
      sections: [{ id: "s", title: "S", color: "blue" as const, first: "load", last: "wait" }],
    };
    const r = ok(apply(d, [{ op: "renameStepId", id: "load", newId: "fetch" }], m));
    expect(r.doc.sections).toEqual([{ ...d.sections[0], first: "fetch" }]);
  });
});

describe("setType", () => {
  test("a chosen ID is kept, config reset, children kept", () => {
    const r = ok(apply(doc(), [{ op: "setType", id: "check", type: "flow.switch" }], m));
    const s = step(r.doc, "check");
    expect(s.type).toBe("flow.switch");
    expect(s.branches?.then?.map((x) => x.id)).toEqual(["notify"]);
    expect(r.renamed).toEqual({});
    expect(r.ids).toEqual({ $1: "check" });
  });

  test("an unknown type fails with node.unknown (also trusted)", () => {
    const cmd: Command = { op: "setType", id: "load", type: "nope.nope" };
    expect(fail(apply(doc(), [cmd], m)).error).toMatchObject({
      code: "node.unknown",
      path: "commands[0].type",
    });
    expect(fail(apply(doc(), [cmd], m, { trusted: true })).error.code).toBe("node.unknown");
  });

  test("a generated ID for which the new type's ID is taken gets the next free one", () => {
    const d = doc();
    d.steps.push({ id: "getDeal", type: "crm.getDeal", config: {} });
    const r = ok(apply(d, [{ op: "setType", id: "sendEmail", type: "crm.getDeal" }], m));
    expect(r.renamed).toEqual({ sendEmail: "getDeal_2" });
  });
});

describe("setTrigger", () => {
  test("a different type resets the config to its defaults, then merges config", () => {
    const r = ok(apply(doc(), [{ op: "setTrigger", type: "util.manual" }], m));
    expect(r.doc.trigger).toEqual({ type: "util.manual", config: { label: "go" } });
    const r2 = ok(
      apply(doc(), [{ op: "setTrigger", type: "util.manual", config: { label: null, n: 1 } }], m),
    );
    expect(r2.doc.trigger).toEqual({ type: "util.manual", config: { n: 1 } });
  });

  test("the same type with config merges it", () => {
    const d = doc();
    d.trigger.config.extra = 1;
    const r = ok(
      apply(d, [{ op: "setTrigger", type: "crm.dealStuckInStage", config: { stage: "won" } }], m),
    );
    expect(r.doc.trigger).toEqual({
      type: "crm.dealStuckInStage",
      config: { stage: "won", extra: 1 },
    });
  });

  test('an unknown type fails with trigger.unknown: Unknown trigger type "<t>" (also trusted)', () => {
    for (const opts of [{}, { trusted: true }]) {
      const e = fail(apply(doc(), [{ op: "setTrigger", type: "x.y" }], m, opts)).error;
      expect(e).toMatchObject({
        code: "trigger.unknown",
        path: "commands[0].type",
        message: 'Unknown trigger type "x.y"',
      });
    }
  });
});

describe("setTriggerConfig and setOutput", () => {
  test("null removes a key; nullIsValue stores null", () => {
    const r = ok(apply(doc(), [{ op: "setTriggerConfig", key: "stage", value: null }], m));
    expect(r.doc.trigger.config).toEqual({});
    const r2 = ok(
      apply(doc(), [{ op: "setTriggerConfig", key: "stage", value: null, nullIsValue: true }], m),
    );
    expect(r2.doc.trigger.config).toEqual({ stage: null });
    const r3 = ok(
      apply(doc(), [{ op: "setOutput", key: "messageId", value: null, nullIsValue: true }], m),
    );
    expect(r3.doc.output).toEqual({ messageId: null });
  });

  test("the merge form sets and removes several keys", () => {
    const r = ok(apply(doc(), [{ op: "setTriggerConfig", config: { a: 1, stage: null } }], m));
    expect(r.doc.trigger.config).toEqual({ a: 1 });
  });

  test("removing the last output key removes output", () => {
    const r = ok(apply(doc(), [{ op: "setOutput", key: "messageId", value: null }], m));
    expect("output" in r.doc).toBe(false);
    const r2 = ok(apply(doc(), [{ op: "setOutput", config: { messageId: null } }], m));
    expect("output" in r2.doc).toBe(false);
  });

  test("setOutput on a doc without output creates it", () => {
    const { output: _, ...d } = doc();
    const r = ok(apply(d, [{ op: "setOutput", key: "k", value: 1 }], m));
    expect(r.doc.output).toEqual({ k: 1 });
  });

  test("any JSON value is accepted, never checked against a schema", () => {
    const r = ok(apply(doc(), [{ op: "setTriggerConfig", key: "stage", value: [1, { a: 2 }] }], m));
    expect(r.doc.trigger.config.stage).toEqual([1, { a: 2 }]);
  });
});

describe("setNote", () => {
  test("4001 chars fails with command.invalid at commands[0].note", () => {
    const r = fail(apply(doc(), [{ op: "setNote", id: "load", note: "x".repeat(4001) }], m));
    expect(r.error.code).toBe("command.invalid");
    expect(r.error.path).toBe("commands[0].note");
  });

  test("4000 chars is fine; null and '' remove a note", () => {
    const long = "x".repeat(4000);
    const r = ok(apply(doc(), [{ op: "setNote", id: "load", note: long }], m));
    expect(step(r.doc, "load").note).toBe(long);
    for (const note of [null, ""]) {
      const cleared = ok(apply(r.doc, [{ op: "setNote", id: "load", note }], m));
      expect("note" in step(cleared.doc, "load")).toBe(false);
    }
  });
});

describe("setDisabled and setColor", () => {
  test("false and null remove the key", () => {
    const d = doc();
    d.steps[0] = { ...(d.steps[0] as Step), disabled: true, color: "gray" };
    const r = ok(
      apply(
        d,
        [
          { op: "setDisabled", id: "load", disabled: false },
          { op: "setColor", id: "load", color: null },
        ],
        m,
      ),
    );
    expect(step(r.doc, "load")).toEqual(doc().steps[0]);
  });
});

describe("renameWorkflow", () => {
  test("a blank name fails the shape check", () => {
    expect(fail(apply(doc(), [{ op: "renameWorkflow", name: " " }], m)).error).toMatchObject({
      code: "command.invalid",
      path: "commands[0].name",
    });
  });
});

describe("changed", () => {
  test("trigger, output and name changes show in changed", () => {
    const r = ok(
      apply(
        doc(),
        [
          { op: "renameWorkflow", name: "New" },
          { op: "setTrigger", type: "util.manual" },
          { op: "setOutput", key: "a", value: 1 },
        ],
        m,
      ),
    );
    expect(r.changed.split("\n")).toEqual([
      '~ workflow "New"',
      "~ trigger util.manual",
      "~ output",
    ]);
  });

  test("a renamed step reads as ~ old → new, not an add and a remove", () => {
    const r = ok(apply(doc(), [{ op: "setType", id: "sendEmail", type: "crm.getDeal" }], m));
    const lines = r.changed.split("\n");
    expect(lines.some((l) => l.startsWith("~ sendEmail → getDeal"))).toBe(true);
    expect(lines.some((l) => l.startsWith("+ ") || l.startsWith("- "))).toBe(false);
    const r2 = ok(apply(doc(), [{ op: "renameStepId", id: "load", newId: "fetch" }], m));
    expect(r2.changed.split("\n")[0]).toMatch(/^~ load → fetch /);
    expect(r2.changed).not.toContain("- load");
  });

  test("a step created and renamed in one batch still reads as added", () => {
    const r = ok(apply(doc(), [addCount, { op: "renameStepId", id: "$1", newId: "n" }], m));
    expect(r.renamed).toEqual({ count: "n" });
    expect(r.changed).toMatch(/^\+ n /);
  });
});

describe("setType and code that reads the step dynamically", () => {
  test("a generated ID is kept when code reads the step opaquely", () => {
    const d = doc();
    d.steps.push({
      id: "shape",
      type: "util.transform",
      config: { code: 'const k = "sendEmail";\nreturn steps[k].messageId;' },
    });
    const r = ok(apply(d, [{ op: "setType", id: "sendEmail", type: "crm.getDeal" }], m));
    expect(step(r.doc, "sendEmail").type).toBe("crm.getDeal");
    expect(findStep(r.doc, "getDeal")).toBeUndefined();
    expect(r.renamed).toEqual({});
    expect(r.ids).toEqual({ $1: "sendEmail" });
  });

  test("plain steps.<id> code is rewritten with the regenerated ID", () => {
    const d = doc();
    d.steps.push({
      id: "shape",
      type: "util.transform",
      config: { code: "return steps.sendEmail.messageId;" },
    });
    const r = ok(apply(d, [{ op: "setType", id: "sendEmail", type: "crm.getDeal" }], m));
    expect(r.renamed).toEqual({ sendEmail: "getDeal" });
    expect(step(r.doc, "shape").config.code).toBe("return steps.getDeal.messageId;");
  });
});

describe("trusted-only annotation checks carry hints", () => {
  test("setColor and setNote", () => {
    const color = fail(
      apply(doc(), [{ op: "setColor", id: "load", color: "red" as never }], m, { trusted: true }),
    ).error;
    expect(color).toMatchObject({
      code: "command.invalid",
      path: "commands[0].color",
      hint: { expected: { enum: ["yellow", "blue", "green", "pink", "purple", "gray", null] } },
    });
    const note = fail(
      apply(doc(), [{ op: "setNote", id: "load", note: "x".repeat(4001) }], m, { trusted: true }),
    ).error;
    expect(note).toMatchObject({
      code: "command.invalid",
      path: "commands[0].note",
      hint: { expected: { maxLength: 4000 } },
    });
  });
});

describe("schema", () => {
  test("the external schema has no nullIsValue on any op", () => {
    expect(
      commandSchema(m, { internal: false }).safeParse({
        op: "setOutput",
        key: "k",
        value: null,
        nullIsValue: true,
      }).success,
    ).toBe(false);
  });
});
