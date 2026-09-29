import { describe, expect, test } from "vitest";
import { FlowlineTreeError, findStep, walkSteps } from "../tree";
import type { Manifest, NodeManifest, Step, WorkflowDoc } from "../types";
import { apply, changedStepIds, FlowlineCommandError } from "./apply";
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

const base = richManifest();
const m: Manifest = { ...base, nodes: [...base.nodes, countNode] };

/** `load` (getDeal), `check` (If) with `notify` in `then`, `wait` (Delay). */
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
          then: [{ id: "notify", type: "crm.sendEmail", config: { to: "a@b.c", subject: "Hi" } }],
          else: [],
        },
      },
      { id: "wait", type: "flow.delay", config: { duration: "1m" } },
    ],
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

const ids = (d: WorkflowDoc) => {
  const out: string[] = [];
  walkSteps(d, (s) => out.push(s.id));
  return out;
};

describe("addStep", () => {
  test("inserts after a step with default config merged under the given config", () => {
    const d = doc();
    const r = ok(
      apply(
        d,
        [
          {
            op: "addStep",
            at: { after: "load" },
            type: "util.count",
            config: { times: 3 },
            name: "Count it",
            note: "A note",
            color: "blue",
            disabled: true,
          },
        ],
        m,
      ),
    );
    expect(ids(r.doc)).toEqual(["load", "count", "check", "notify", "wait"]);
    expect(r.doc.steps[1]).toEqual({
      id: "count",
      type: "util.count",
      config: { label: "n", times: 3 },
      name: "Count it",
      note: "A note",
      color: "blue",
      disabled: true,
    });
    expect(r.ids).toEqual({ $1: "count" });
    expect(r.renamed).toEqual({});
  });

  test("every At form", () => {
    const r = ok(
      apply(
        doc(),
        [
          { op: "addStep", at: { start: true }, type: "flow.stop" },
          { op: "addStep", at: { before: "wait" }, type: "flow.stop" },
          { op: "addStep", at: { in: { stepId: "check", branch: "then" } }, type: "flow.stop" },
          {
            op: "addStep",
            at: { in: { stepId: "check", branch: "then" }, index: 0 },
            type: "flow.stop",
          },
          { op: "addStep", at: { in: { stepId: "check", branch: "else" } }, type: "flow.stop" },
        ],
        m,
      ),
    );
    expect(r.doc.steps.map((s) => s.id)).toEqual(["stop", "load", "check", "stop_2", "wait"]);
    const check = findStep(r.doc, "check")?.step as Step;
    expect(check.branches?.then?.map((s) => s.id)).toEqual(["stop_4", "notify", "stop_3"]);
    expect(check.branches?.else?.map((s) => s.id)).toEqual(["stop_5"]);
    expect(r.ids).toEqual({ $1: "stop", $2: "stop_2", $3: "stop_3", $4: "stop_4", $5: "stop_5" });
  });

  test("a branching node gets its declared branches", () => {
    const r = ok(apply(doc(), [{ op: "addStep", at: { start: true }, type: "flow.if" }], m));
    expect(r.doc.steps[0]).toEqual({
      id: "if",
      type: "flow.if",
      config: {},
      // biome-ignore lint/suspicious/noThenProperty: a branch ID, not a thenable
      branches: { then: [], else: [] },
    });
  });

  test("an explicit ID is used, and must be valid and free", () => {
    const r = ok(
      apply(doc(), [{ op: "addStep", at: { start: true }, type: "flow.stop", id: "halt" }], m),
    );
    expect(r.doc.steps[0]?.id).toBe("halt");
    expect(r.ids).toEqual({ $1: "halt" });

    const taken = fail(
      apply(doc(), [{ op: "addStep", at: { start: true }, type: "flow.stop", id: "load" }], m),
    );
    expect(taken.error).toMatchObject({ index: 0, path: "commands[0].id", code: "id.taken" });

    const invalid = fail(
      apply(doc(), [{ op: "addStep", at: { start: true }, type: "flow.stop", id: "9x" }], m),
    );
    expect(invalid.error).toMatchObject({ path: "commands[0].id", code: "id.invalid" });
  });

  test("an unknown node type fails with node.unknown and the closest types", () => {
    for (const trusted of [false, true]) {
      const r = fail(
        apply(doc(), [{ op: "addStep", at: { start: true }, type: "crm.getDeals" }], m, {
          trusted,
        }),
      );
      expect(r.error.code).toBe("node.unknown");
      expect(r.error.path).toBe("commands[0].type");
      expect(r.error.message).toContain('Unknown node type "crm.getDeals"');
      const hint = r.error.hint as { closest: string[] };
      expect(hint.closest[0]).toBe("crm.getDeal");
      expect(hint.closest.length).toBeLessThanOrEqual(10);
    }
  });

  test("an unknown branch fails with branch.unknown listing the step's branches", () => {
    const r = fail(
      apply(
        doc(),
        [{ op: "addStep", at: { in: { stepId: "check", branch: "maybe" } }, type: "flow.stop" }],
        m,
      ),
    );
    expect(r.error).toMatchObject({ code: "branch.unknown", path: "commands[0].at.in.branch" });
    expect(r.error.hint).toEqual({ branches: ["then", "else"] });
  });

  test("an index out of range fails with location.invalid", () => {
    const r = fail(
      apply(
        doc(),
        [
          {
            op: "addStep",
            at: { in: { stepId: "check", branch: "then" }, index: 5 },
            type: "flow.stop",
          },
        ],
        m,
      ),
    );
    expect(r.error).toMatchObject({ code: "location.invalid", path: "commands[0].at.index" });
  });

  test("a declared branch the step doesn't hold yet is created", () => {
    const d = doc();
    const check = d.steps[1] as Step;
    // biome-ignore lint/suspicious/noThenProperty: a branch ID, not a thenable
    check.branches = { then: check.branches?.then ?? [] };
    const r = ok(
      apply(
        d,
        [{ op: "addStep", at: { in: { stepId: "check", branch: "else" } }, type: "flow.stop" }],
        m,
      ),
    );
    expect(findStep(r.doc, "check")?.step.branches?.else?.map((s) => s.id)).toEqual(["stop"]);
  });
});

describe("removeStep", () => {
  test("removes the step and its subtree", () => {
    const r = ok(apply(doc(), [{ op: "removeStep", id: "check" }], m));
    expect(ids(r.doc)).toEqual(["load", "wait"]);
  });

  test("shrinks a section whose endpoint it was", () => {
    const d = { ...doc(), sections: [sec("s", "load", "check")] };
    const r = ok(apply(d, [{ op: "removeStep", id: "load" }], m));
    expect(r.doc.sections).toEqual([sec("s", "check", "check")]);
  });
});

function sec(id: string, first: string, last: string) {
  return { id, title: id.toUpperCase(), color: "blue" as const, first, last };
}

describe("moveStep", () => {
  test("moves before/after/into a branch, resolving the anchor after removal", () => {
    const r = ok(
      apply(
        doc(),
        [
          { op: "moveStep", id: "wait", to: { before: "load" } },
          { op: "moveStep", id: "load", to: { in: { stepId: "check", branch: "else" } } },
          { op: "moveStep", id: "notify", to: { after: "check" } },
        ],
        m,
      ),
    );
    expect(r.doc.steps.map((s) => s.id)).toEqual(["wait", "check", "notify"]);
    expect(findStep(r.doc, "check")?.step.branches).toEqual({
      // biome-ignore lint/suspicious/noThenProperty: a branch ID, not a thenable
      then: [],
      else: [doc().steps[0]],
    });
  });

  test("moving onto its own position is a no-op", () => {
    const d = doc();
    for (const to of [{ after: "load" }, { before: "wait" }, { after: "check" }]) {
      expect(ok(apply(d, [{ op: "moveStep", id: "check", to }], m)).doc).toBe(d);
    }
    expect(ok(apply(d, [{ op: "moveStep", id: "load", to: { start: true } }], m)).doc).toBe(d);
    expect(
      ok(
        apply(
          d,
          [{ op: "moveStep", id: "notify", to: { in: { stepId: "check", branch: "then" } } }],
          m,
        ),
      ).doc,
    ).toBe(d);
  });

  test("a target inside the step's own subtree fails with move.intoSelf", () => {
    const r = fail(apply(doc(), [{ op: "moveStep", id: "check", to: { after: "notify" } }], m));
    expect(r.error).toMatchObject({ code: "move.intoSelf", index: 0 });
    const into = fail(
      apply(
        doc(),
        [{ op: "moveStep", id: "check", to: { in: { stepId: "check", branch: "else" } } }],
        m,
      ),
    );
    expect(into.error.code).toBe("move.intoSelf");
  });

  test("a moved member landing within its section stays in it", () => {
    const d = {
      ...doc(),
      steps: [...doc().steps, { id: "extra", type: "flow.stop", config: {} }],
      sections: [sec("s", "load", "wait")],
    };
    const r = ok(apply(d, [{ op: "moveStep", id: "load", to: { after: "check" } }], m));
    expect(r.doc.steps.map((s) => s.id)).toEqual(["check", "load", "wait", "extra"]);
    expect(r.doc.sections).toEqual([sec("s", "check", "wait")]);
  });
});

describe("setConfig", () => {
  test("the key form sets a value", () => {
    const r = ok(apply(doc(), [{ op: "setConfig", id: "wait", key: "duration", value: "5m" }], m));
    expect(findStep(r.doc, "wait")?.step.config).toEqual({ duration: "5m" });
  });

  test("null removes the key; nullIsValue stores null", () => {
    const removed = ok(
      apply(doc(), [{ op: "setConfig", id: "notify", key: "subject", value: null }], m),
    );
    expect(findStep(removed.doc, "notify")?.step.config).toEqual({ to: "a@b.c" });
    const stored = ok(
      apply(
        doc(),
        [{ op: "setConfig", id: "notify", key: "subject", value: null, nullIsValue: true }],
        m,
      ),
    );
    expect(findStep(stored.doc, "notify")?.step.config).toEqual({ to: "a@b.c", subject: null });
  });

  test("the config form merges, with null removing keys", () => {
    const d = doc();
    const r = ok(
      apply(d, [{ op: "setConfig", id: "notify", config: { body: "Yo", subject: null } }], m),
    );
    expect(findStep(r.doc, "notify")?.step.config).toEqual({ to: "a@b.c", body: "Yo" });
    const merged = ok(
      apply(d, [{ op: "setConfig", id: "notify", config: { a: 1, b: null } } as Command], m),
    );
    expect(findStep(merged.doc, "notify")?.step.config).toEqual({
      to: "a@b.c",
      subject: "Hi",
      a: 1,
    });
  });

  test("a switch cases change syncs its branches", () => {
    const d: WorkflowDoc = {
      ...doc(),
      steps: [
        {
          id: "sw",
          type: "flow.switch",
          config: { value: "x", cases: [] },
          branches: { default: [] },
        },
      ],
    };
    const r = ok(
      apply(
        d,
        [
          {
            op: "setConfig",
            id: "sw",
            key: "cases",
            value: [{ id: "big", label: "Big", value: "big" }],
          },
        ],
        m,
      ),
    );
    expect(Object.keys(r.doc.steps[0]?.branches ?? {})).toEqual(["big", "default"]);
    const viaConfig = ok(
      apply(
        d,
        [{ op: "setConfig", id: "sw", config: { cases: [{ id: "a", label: "A", value: "a" }] } }],
        m,
      ),
    );
    expect(Object.keys(viaConfig.doc.steps[0]?.branches ?? {})).toEqual(["a", "default"]);
  });

  test("a half-typed invalid value is stored and reported, not rejected", () => {
    const d: WorkflowDoc = {
      ...doc(),
      steps: [{ id: "count", type: "util.count", config: { times: 1 } }],
    };
    const r = ok(apply(d, [{ op: "setConfig", id: "count", key: "times", value: "12a" }], m));
    expect(r.doc.steps[0]?.config.times).toBe("12a");
    expect(r.issues.added).toEqual([
      expect.objectContaining({ code: "config.invalid", stepId: "count", field: "times" }),
    ]);
  });

  test("an unknown step fails with step.notFound and a near-miss hint, leaving the doc alone", () => {
    const d = doc();
    const before = structuredClone(d);
    const r = fail(apply(d, [{ op: "setConfig", id: "notfy", key: "to", value: "x" }], m));
    expect(r.error).toMatchObject({
      index: 0,
      path: "commands[0].id",
      code: "step.notFound",
      message: 'Step "notfy" not found',
    });
    const hint = r.error.hint as { closest: string[] };
    expect(hint.closest).toContain("notify");
    expect(hint.closest.length).toBeLessThanOrEqual(5);
    expect(d).toEqual(before);
  });
});

describe("step.notFound on every command", () => {
  const cmds: Command[] = [
    { op: "addStep", at: { after: "lod" }, type: "flow.stop" },
    { op: "removeStep", id: "lod" },
    { op: "moveStep", id: "lod", to: { start: true } },
    { op: "moveStep", id: "wait", to: { before: "lod" } },
    { op: "setConfig", id: "lod", config: {} },
  ];
  for (const cmd of cmds) {
    test(`${cmd.op} ${JSON.stringify(cmd)}`, () => {
      const d = doc();
      const before = structuredClone(d);
      const r = fail(apply(d, [cmd], m));
      expect(r.error.code).toBe("step.notFound");
      expect(r.error.message).toBe('Step "lod" not found');
      expect((r.error.hint as { closest: string[] }).closest).toContain("load");
      expect(d).toEqual(before);
    });
  }
});

describe("placeholders", () => {
  test("$n names the step commands[n-1] created, in IDs and templates", () => {
    const d: WorkflowDoc = { ...doc(), steps: [] };
    const r = ok(
      apply(
        d,
        [
          { op: "addStep", at: { start: true }, type: "crm.getDeal" },
          {
            op: "addStep",
            at: { after: "$1" },
            type: "crm.sendEmail",
            config: { subject: { $tpl: "Deal {{ steps.$1.deal.name }}" } },
          },
          { op: "setConfig", id: "$2", key: "to", value: "a@b.c" },
        ],
        m,
      ),
    );
    expect(r.ids).toEqual({ $1: "getDeal", $2: "sendEmail" });
    expect(r.doc.steps.map((s) => s.id)).toEqual(["getDeal", "sendEmail"]);
    expect(r.doc.steps[1]?.config).toEqual({
      subject: { $tpl: "Deal {{ steps.getDeal.deal.name }}" },
      to: "a@b.c",
    });
  });

  test("a placeholder inside a $ref path resolves", () => {
    const d: WorkflowDoc = { ...doc(), steps: [] };
    const r = ok(
      apply(
        d,
        [
          { op: "addStep", at: { start: true }, type: "crm.getDeal" },
          {
            op: "addStep",
            at: { after: "$1" },
            type: "crm.sendEmail",
            config: { to: { $ref: "steps.$1.deal.ownerId" } },
          },
          {
            op: "setConfig",
            id: "$2",
            config: { subject: { $tpl: "{{steps.$1.deal.id}} / {{ trigger.deal.id }}" } },
          },
        ],
        m,
      ),
    );
    expect(r.doc.steps[1]?.config).toEqual({
      to: { $ref: "steps.getDeal.deal.ownerId" },
      subject: { $tpl: "{{steps.getDeal.deal.id}} / {{ trigger.deal.id }}" },
    });
  });

  test("an unknown placeholder fails with placeholder.unknown and what is defined", () => {
    const r = fail(apply(doc(), [{ op: "removeStep", id: "$9" }], m));
    expect(r.error).toMatchObject({ code: "placeholder.unknown", path: "commands[0].id" });
    expect(r.error.hint).toEqual({ defined: [], note: "$n is the result of commands[n-1]" });

    const later = fail(
      apply(
        doc(),
        [
          { op: "addStep", at: { start: true }, type: "flow.stop" },
          { op: "setConfig", id: "load", key: "dealId", value: { $ref: "steps.$3.deal.id" } },
        ],
        m,
      ),
    );
    expect(later.error).toMatchObject({
      index: 1,
      code: "placeholder.unknown",
      path: "commands[1].value",
    });
    expect((later.error.hint as { defined: string[] }).defined).toEqual(["$1"]);
  });

  test("a command that creates nothing defines no placeholder", () => {
    const r = fail(
      apply(
        doc(),
        [
          { op: "setConfig", id: "wait", key: "duration", value: "2m" },
          { op: "removeStep", id: "$1" },
        ],
        m,
      ),
    );
    expect(r.error.code).toBe("placeholder.unknown");
  });
});

describe("atomicity", () => {
  test("a batch failing at its third command applies nothing", () => {
    const d = doc();
    const before = structuredClone(d);
    const r = fail(
      apply(
        d,
        [
          { op: "addStep", at: { in: { stepId: "check", branch: "else" } }, type: "crm.getDeal" },
          {
            op: "addStep",
            at: { after: "$1" },
            type: "crm.sendEmail",
            config: { subject: { $tpl: "Deal {{ steps.$1.deal.id }}" } },
          },
          { op: "setConfig", id: "nope", key: "to", value: "x" },
        ],
        m,
      ),
    );
    expect(r.error.index).toBe(2);
    expect(r.error.path.startsWith("commands[2]")).toBe(true);
    expect(r.error.hint).toBeDefined();
    expect(d).toEqual(before);
    expect(ids(d)).not.toContain("getDeal");
    expect(ids(d)).not.toContain("sendEmail");
  });
});

describe("shape errors", () => {
  test("every command is checked before any runs; error is the first, more the rest", () => {
    const d = doc();
    const r = fail(
      apply(
        d,
        [
          { op: "removeStep", id: "wait" },
          { op: "addStep", type: "flow.stop" } as unknown as Command,
          { op: "removeStep", id: 5 } as unknown as Command,
          { op: "frobnicate" } as unknown as Command,
        ],
        m,
      ),
    );
    expect(r.error).toMatchObject({ index: 1, path: "commands[1].at", code: "command.invalid" });
    expect(r.more?.map((e) => [e.index, e.path, e.code])).toEqual([
      [2, "commands[2].id", "command.invalid"],
      [3, "commands[3].op", "command.invalid"],
    ]);
  });

  test("at most 9 more errors", () => {
    const bad = Array.from({ length: 15 }, () => ({ op: "removeStep" }) as unknown as Command);
    const r = fail(apply(doc(), bad, m));
    expect(r.error.index).toBe(0);
    expect(r.more).toHaveLength(9);
  });

  test("the command.invalid hint is the compact schema at the failing path, ≤ 1500 chars", () => {
    const r = fail(apply(doc(), [{ op: "addStep", type: "flow.stop" } as unknown as Command], m));
    const hint = r.error.hint as { expected: { properties?: Record<string, unknown> } };
    expect(hint.expected.properties?.at).toBeDefined();
    expect(JSON.stringify(hint.expected).length).toBeLessThanOrEqual(1500);
  });

  test("a deep path names the field", () => {
    const r = fail(
      apply(
        doc(),
        [{ op: "addStep", at: { after: 5 }, type: "flow.stop" } as unknown as Command],
        m,
      ),
    );
    expect(r.error.path).toBe("commands[0].at.after");
  });

  test("unknown keys are rejected and named", () => {
    const r = fail(
      apply(doc(), [{ op: "removeStep", id: "wait", extra: 1 } as unknown as Command], m),
    );
    expect(r.error.code).toBe("command.invalid");
    expect(r.error.message).toContain("extra");
  });

  test("setConfig.value is any JSON value, never checked against the field", () => {
    const r = ok(
      apply(
        doc(),
        [{ op: "setConfig", id: "wait", key: "duration", value: { deep: [1, "x", null] } }],
        m,
      ),
    );
    expect(findStep(r.doc, "wait")?.step.config.duration).toEqual({ deep: [1, "x", null] });
    const notJson = fail(
      apply(
        doc(),
        [{ op: "setConfig", id: "wait", key: "duration", value: () => 1 } as unknown as Command],
        m,
      ),
    );
    expect(notJson.error).toMatchObject({ code: "command.invalid", path: "commands[0].value" });
  });

  test("a missing value on the key form is a shape error", () => {
    const r = fail(
      apply(doc(), [{ op: "setConfig", id: "wait", key: "duration" } as unknown as Command], m),
    );
    expect(r.error).toMatchObject({ code: "command.invalid", path: "commands[0].value" });
  });
});

describe("empty and no-op batches", () => {
  test("apply(doc, []) returns the input doc and an empty report", () => {
    const d = doc();
    const r = ok(apply(d, [], m));
    expect(r.doc).toBe(d);
    expect(r.changed).toBe("");
    expect(r.issues).toEqual({ added: [], cleared: [] });
    expect(r.ids).toEqual({});
  });

  const noops: [string, Command][] = [
    ["moveStep onto its own position", { op: "moveStep", id: "check", to: { after: "load" } }],
    [
      "setConfig with an equal value",
      { op: "setConfig", id: "wait", key: "duration", value: "1m" },
    ],
    ["setConfig { config: {} }", { op: "setConfig", id: "wait", config: {} }],
    ["setConfig removing an absent key", { op: "setConfig", id: "wait", key: "nope", value: null }],
    [
      "setConfig { config } with equal values and absent removals",
      { op: "setConfig", id: "wait", config: { duration: "1m", gone: null } },
    ],
  ];
  for (const [name, cmd] of noops) {
    for (const trusted of [false, true]) {
      test(`${name}${trusted ? " (trusted)" : ""} returns the input doc`, () => {
        const d = doc();
        const r = ok(apply(d, [cmd], m, trusted ? { trusted, report: false } : {}));
        expect(r.doc).toBe(d);
        expect(r.changed).toBe("");
        expect(r.issues).toEqual({ added: [], cleared: [] });
      });
    }
  }
});

describe("report", () => {
  test("a missing required field is added, and filling it clears it", () => {
    const d = doc();
    const r = ok(apply(d, [{ op: "addStep", at: { after: "wait" }, type: "util.count" }], m));
    expect(r.issues.added).toEqual([
      expect.objectContaining({ code: "config.required", stepId: "count", field: "times" }),
    ]);
    expect(r.issues.cleared).toEqual([]);
    const filled = ok(apply(r.doc, [{ op: "setConfig", id: "count", key: "times", value: 2 }], m));
    expect(filled.issues.added).toEqual([]);
    expect(filled.issues.cleared).toEqual([
      expect.objectContaining({ code: "config.required", stepId: "count", field: "times" }),
    ]);
  });

  test("added is capped at 20, with a getIssues follow-up for the rest", () => {
    const cmds: Command[] = Array.from({ length: 30 }, () => ({
      op: "addStep",
      at: { after: "wait" },
      type: "util.count",
    }));
    const r = ok(apply(doc(), cmds, m));
    expect(r.issues.added).toHaveLength(20);
    expect(r.issues.more).toEqual({ added: 10, fetch: { tool: "getIssues", args: {} } });
  });

  test("changed lists added, updated and removed steps in pre-order", () => {
    const r = ok(
      apply(
        doc(),
        [
          {
            op: "addStep",
            at: { start: true },
            type: "flow.delay",
            name: "Pause",
            config: { duration: "1s" },
          },
          { op: "setConfig", id: "notify", key: "subject", value: "Yo" },
          { op: "removeStep", id: "wait" },
        ],
        m,
      ),
    );
    expect(r.changed.split("\n")).toEqual([
      "+ delay  Delay “Pause”",
      "~ notify  Send email",
      "- wait",
    ]);
  });

  test("changed shows section changes", () => {
    const d = { ...doc(), sections: [sec("s", "load", "check")] };
    const r = ok(apply(d, [{ op: "removeStep", id: "load" }], m));
    expect(r.changed).toContain("- load");
    expect(r.changed).toContain('~ ▣ section s "S" [blue]');
    const gone = ok(
      apply(
        { ...doc(), sections: [sec("s", "wait", "wait")] },
        [{ op: "removeStep", id: "wait" }],
        m,
      ),
    );
    expect(gone.changed.split("\n")).toEqual(["- wait", "- ▣ s"]);
  });

  test("a moved step shows as updated", () => {
    const r = ok(apply(doc(), [{ op: "moveStep", id: "wait", to: { start: true } }], m));
    expect(r.changed).toBe("~ wait  Delay");
  });

  test("300 changes cap changed at 2000 chars with a getSteps marker", () => {
    const cmds: Command[] = Array.from({ length: 300 }, () => ({
      op: "addStep",
      at: { after: "wait" },
      type: "flow.stop",
    }));
    const r = ok(apply(doc(), cmds, m));
    expect(r.changed.length).toBeLessThanOrEqual(2000);
    const last = r.changed.split("\n").at(-1) as string;
    expect(last).toMatch(/^… \d+ more changes: getSteps\(\{ids:\["stop/);
    expect(r.changed.startsWith("+ stop")).toBe(true);
  });

  test("report: false skips the report but keeps ids", () => {
    const r = ok(
      apply(doc(), [{ op: "addStep", at: { start: true }, type: "util.count" }], m, {
        report: false,
      }),
    );
    expect(r.changed).toBe("");
    expect(r.issues).toEqual({ added: [], cleared: [] });
    expect(r.ids).toEqual({ $1: "count" });
  });
});

describe("trusted mode", () => {
  const batch: Command[] = [
    { op: "setConfig", id: "wait", key: "duration", value: "5m" },
    { op: "setConfig", id: "notify", config: { subject: "Yo", body: "Hey" } },
  ];

  test("gives the same doc as the default mode, with no report", () => {
    const normal = ok(apply(doc(), batch, m));
    const trusted = ok(apply(doc(), batch, m, { trusted: true, report: false }));
    expect(trusted.doc).toEqual(normal.doc);
    expect(trusted.changed).toBe("");
    expect(normal.changed).not.toBe("");
  });

  test("skips the shape check, but handlers still reject unknown IDs", () => {
    const loose = { op: "removeStep", id: "wait", extra: 1 } as unknown as Command;
    expect(ok(apply(doc(), [loose], m, { trusted: true, report: false })).doc.steps).toHaveLength(
      2,
    );
    const r = fail(
      apply(doc(), [{ op: "removeStep", id: "gone", extra: 1 } as unknown as Command], m, {
        trusted: true,
        report: false,
      }),
    );
    expect(r.error.code).toBe("step.notFound");
  });

  test("setConfig on a 200-step doc with sections stays fast", () => {
    const steps: Step[] = [{ id: "load", type: "crm.getDeal", config: { dealId: "d" } }];
    for (let i = 0; i < 199; i++) {
      steps.push({
        id: `s${i}`,
        type: "crm.sendEmail",
        config: { to: { $ref: "steps.load.deal.ownerId" }, subject: `Hi ${i}` },
      });
    }
    const sections = Array.from({ length: 20 }, (_, k) =>
      sec(`sec${k}`, `s${k * 10}`, `s${k * 10 + 5}`),
    );
    let d: WorkflowDoc = { ...doc(), steps, sections };
    d = ok(
      apply(d, [{ op: "setConfig", id: "s0", key: "subject", value: "warm" }], m, {
        trusted: true,
        report: false,
      }),
    ).doc;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 1; i <= 7; i++) {
      const t0 = performance.now();
      const r = ok(
        apply(d, [{ op: "setConfig", id: `s${i * 20}`, key: "subject", value: `T${i}` }], m, {
          trusted: true,
          report: false,
        }),
      );
      best = Math.min(best, performance.now() - t0);
      d = r.doc;
    }
    expect(d.sections).toBe(sections);
    expect(best).toBeLessThan(20);
  });
});

describe("changedStepIds", () => {
  test("added, updated (own fields or moved) and removed steps and sections", () => {
    const before = { ...doc(), sections: [sec("a", "load", "load"), sec("b", "wait", "wait")] };
    const after = ok(
      apply(
        before,
        [
          { op: "addStep", at: { start: true }, type: "flow.stop" },
          { op: "setConfig", id: "notify", key: "subject", value: "Yo" },
          { op: "removeStep", id: "wait" },
        ],
        m,
      ),
    ).doc;
    expect(changedStepIds(before, after)).toEqual({
      added: ["stop"],
      updated: ["notify"],
      removed: ["wait"],
      sections: { added: [], updated: [], removed: ["b"] },
    });
  });

  test("a parent whose child changed is not updated", () => {
    const before = doc();
    const after = ok(apply(before, [{ op: "setConfig", id: "notify", config: { a: 1 } }], m)).doc;
    expect(changedStepIds(before, after).updated).toEqual(["notify"]);
  });
});

describe("FlowlineCommandError", () => {
  test("is a FlowlineTreeError carrying the ApplyError", () => {
    const r = fail(apply(doc(), [{ op: "removeStep", id: "x" }], m));
    const e = new FlowlineCommandError(r.error);
    expect(e).toBeInstanceOf(FlowlineTreeError);
    expect(e.name).toBe("FlowlineCommandError");
    expect(e.message).toBe(r.error.message);
    expect(e.error).toBe(r.error);
  });
});
