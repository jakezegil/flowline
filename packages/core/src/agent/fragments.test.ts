import { describe, expect, test } from "vitest";
import { findStep } from "../tree";
import type { Manifest, NodeManifest, Section, Step, WorkflowDoc } from "../types";
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

const base = richManifest();
const m: Manifest = { ...base, nodes: [...base.nodes, countNode] };

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
          then: [{ id: "notify", type: "crm.sendEmail", config: { to: "a@b.c", subject: "Hi" } }],
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

const sec = (id: string, first: string, last: string): Section => ({
  id,
  title: id.toUpperCase(),
  color: "blue",
  first,
  last,
});

function ok(r: ApplyResult): Extract<ApplyResult, { ok: true }> {
  if (!r.ok) throw new Error(`apply failed: ${JSON.stringify(r.error)}`);
  return r;
}

function fail(r: ApplyResult): Extract<ApplyResult, { ok: false }> {
  if (r.ok) throw new Error("apply unexpectedly succeeded");
  return r;
}

const top = (d: WorkflowDoc) => d.steps.map((s) => s.id);

describe("insertSteps", () => {
  test("builds the spec §3 example flow in one command", () => {
    const empty: WorkflowDoc = { id: "deal-stuck", name: "Deal stuck", trigger, steps: [] };
    const r = ok(
      apply(
        empty,
        [
          {
            op: "insertSteps",
            at: { start: true },
            steps: [
              { ref: "deal", type: "crm.getDeal", config: { dealId: { $ref: "trigger.deal.id" } } },
              {
                ref: "check",
                id: "recheck",
                type: "flow.if",
                branches: {
                  // biome-ignore lint/suspicious/noThenProperty: a branch ID, not a thenable
                  then: [
                    {
                      id: "notifyOwner",
                      type: "crm.sendEmail",
                      config: {
                        to: { $ref: "steps.$deal.deal.ownerId" },
                        subject: "Deal stuck in stage",
                        body: { $tpl: "Stage: {{steps.$deal.deal.stage}}" },
                      },
                      note: "Owner, not assignee",
                    },
                  ],
                  else: [{ id: "stopMoved", type: "flow.stop" }],
                },
              },
              { id: "delay_1m", type: "flow.delay", config: { duration: "1m" } },
            ],
            section: { title: "Check the deal", color: "blue", note: "Skip if moved" },
          },
        ],
        m,
      ),
    );
    expect(r.doc).toEqual({
      id: "deal-stuck",
      name: "Deal stuck",
      trigger,
      steps: [
        { id: "getDeal", type: "crm.getDeal", config: { dealId: { $ref: "trigger.deal.id" } } },
        {
          id: "recheck",
          type: "flow.if",
          config: {},
          branches: {
            // biome-ignore lint/suspicious/noThenProperty: a branch ID, not a thenable
            then: [
              {
                id: "notifyOwner",
                type: "crm.sendEmail",
                config: {
                  to: { $ref: "steps.getDeal.deal.ownerId" },
                  subject: "Deal stuck in stage",
                  body: { $tpl: "Stage: {{steps.getDeal.deal.stage}}" },
                },
                note: "Owner, not assignee",
              },
            ],
            else: [{ id: "stopMoved", type: "flow.stop", config: {} }],
          },
        },
        { id: "delay_1m", type: "flow.delay", config: { duration: "1m" } },
      ],
      sections: [
        {
          id: "check_the_deal",
          title: "Check the deal",
          color: "blue",
          note: "Skip if moved",
          first: "getDeal",
          last: "delay_1m",
        },
      ],
    });
    expect(r.ids).toEqual({ $1: "getDeal", $deal: "getDeal", $check: "recheck" });
    // `value` is missing: reported, not rejected.
    expect(r.issues.added.map((i) => [i.code, i.stepId])).toContainEqual([
      "config.required",
      "recheck",
    ]);
  });

  test("the same result in trusted mode", () => {
    const cmds: Command[] = [
      {
        op: "insertSteps",
        at: { after: "load" },
        steps: [{ ref: "n", type: "util.count", config: { times: 2 } }, { type: "flow.stop" }],
      },
    ];
    const a = ok(apply(doc(), cmds, m));
    const b = ok(apply(doc(), cmds, m, { trusted: true, report: false }));
    expect(b.doc).toEqual(a.doc);
    expect(b.ids).toEqual(a.ids);
    expect(top(a.doc)).toEqual(["load", "count", "stop", "check", "wait"]);
    expect(findStep(a.doc, "count")?.step.config).toEqual({ label: "n", times: 2 });
  });

  test("into a branch at an index", () => {
    const r = ok(
      apply(
        doc(),
        [
          {
            op: "insertSteps",
            at: { in: { stepId: "check", branch: "then" }, index: 0 },
            steps: [{ id: "one", type: "flow.stop" }],
          },
        ],
        m,
      ),
    );
    expect(findStep(r.doc, "one")?.location).toEqual({
      parentId: "check",
      branch: "then",
      index: 0,
    });
  });

  test("IDs are checked against the doc and the steps built so far", () => {
    const r = ok(
      apply(
        doc(),
        [
          {
            op: "insertSteps",
            at: { start: true },
            steps: [{ type: "crm.getDeal" }, { type: "crm.getDeal" }],
          },
        ],
        m,
      ),
    );
    expect(top(r.doc).slice(0, 2)).toEqual(["getDeal", "getDeal_2"]);

    const taken = fail(
      apply(
        doc(),
        [{ op: "insertSteps", at: { start: true }, steps: [{ id: "load", type: "flow.stop" }] }],
        m,
      ),
    );
    expect(taken.error.code).toBe("id.taken");
    expect(taken.error.path).toBe("commands[0].steps[0].id");

    const twice = fail(
      apply(
        doc(),
        [
          {
            op: "insertSteps",
            at: { start: true },
            steps: [
              { id: "x", type: "flow.stop" },
              { type: "flow.if", branches: { else: [{ id: "x", type: "flow.stop" }] } },
            ],
          },
        ],
        m,
      ),
    );
    expect(twice.error.code).toBe("id.taken");
    expect(twice.error.path).toBe("commands[0].steps[1].branches.else[0].id");
  });

  test("a duplicate ref fails with command.invalid", () => {
    const r = fail(
      apply(
        doc(),
        [
          {
            op: "insertSteps",
            at: { start: true },
            steps: [
              { ref: "a", type: "flow.stop" },
              { ref: "a", type: "flow.stop" },
            ],
          },
        ],
        m,
      ),
    );
    expect(r.error.code).toBe("command.invalid");
    expect(r.error.path).toBe("commands[0].steps[1].ref");
  });

  test.each([
    ["checked", false],
    ["trusted", true],
  ])("an unknown type deep in a branch fails with node.unknown (%s)", (_, trusted) => {
    const d = doc();
    const before = structuredClone(d);
    const r = fail(
      apply(
        d,
        [
          {
            op: "insertSteps",
            at: { start: true },
            steps: [
              { type: "flow.stop" },
              { type: "flow.if", branches: { else: [{ type: "flow.stopp" }] } },
            ],
          },
        ],
        m,
        { trusted },
      ),
    );
    expect(r.error.code).toBe("node.unknown");
    expect(r.error.path).toBe("commands[0].steps[1].branches.else[0].type");
    expect((r.error.hint as { closest: string[] }).closest).toContain("flow.stop");
    expect(d).toEqual(before);
  });

  test("an undeclared branch key fails with branch.unknown and the declared IDs", () => {
    const r = fail(
      apply(
        doc(),
        [
          {
            op: "insertSteps",
            at: { start: true },
            steps: [{ type: "flow.if", branches: { maybe: [{ type: "flow.stop" }] } }],
          },
        ],
        m,
      ),
    );
    expect(r.error.code).toBe("branch.unknown");
    expect(r.error.path).toBe("commands[0].steps[0].branches.maybe");
    expect(r.error.hint).toEqual({ branches: ["then", "else"] });
  });

  test("a branch key named like an Object.prototype member is just unknown", () => {
    const r = fail(
      apply(
        doc(),
        [
          {
            op: "insertSteps",
            at: { start: true },
            steps: [{ type: "flow.stop", branches: { constructor: [] } }],
          },
        ],
        m,
      ),
    );
    expect(r.error.code).toBe("branch.unknown");
    expect(r.error.path).toBe("commands[0].steps[0].branches.constructor");
  });

  test("a loop's body is accepted, and missing declared branches are filled in", () => {
    const r = ok(
      apply(
        doc(),
        [
          {
            op: "insertSteps",
            at: { after: "load" },
            steps: [
              {
                id: "each",
                type: "flow.forEach",
                config: { items: { $ref: "trigger.deal" } },
                branches: { body: [{ id: "inner", type: "flow.stop" }] },
              },
              { id: "iff", type: "flow.if", config: { value: true } },
            ],
          },
        ],
        m,
      ),
    );
    expect(findStep(r.doc, "each")?.step.branches).toEqual({
      body: [{ id: "inner", type: "flow.stop", config: {} }],
    });
    // biome-ignore lint/suspicious/noThenProperty: a branch ID, not a thenable
    expect(findStep(r.doc, "iff")?.step.branches).toEqual({ then: [], else: [] });
  });

  test("a ref to a later step fails with ref.outOfScope and the valid refs", () => {
    const d = doc();
    const before = structuredClone(d);
    const r = fail(
      apply(
        d,
        [
          {
            op: "insertSteps",
            at: { after: "load" },
            steps: [
              {
                type: "crm.sendEmail",
                config: { to: { $ref: "steps.$later.deal.ownerId" }, subject: "x" },
              },
              { ref: "later", type: "crm.getDeal", config: { dealId: "d" } },
            ],
          },
        ],
        m,
      ),
    );
    expect(r.error.code).toBe("ref.outOfScope");
    expect(r.error.path).toBe("commands[0].steps[0].config.to");
    const refs = (r.error.hint as { refs: { ref: string }[] }).refs.map((x) => x.ref);
    expect(refs).toContain("steps.load");
    expect(refs).not.toContain("steps.getDeal");
    expect(d).toEqual(before);
  });

  test("a ref into a sibling branch fails with ref.outOfScope", () => {
    const r = fail(
      apply(
        doc(),
        [
          {
            op: "insertSteps",
            at: { after: "load" },
            steps: [
              {
                type: "flow.if",
                config: { value: true },
                branches: {
                  // biome-ignore lint/suspicious/noThenProperty: a branch ID, not a thenable
                  then: [{ ref: "a", type: "crm.getDeal", config: { dealId: "d" } }],
                  else: [
                    { type: "flow.stop" },
                    {
                      type: "crm.sendEmail",
                      config: { to: { $tpl: "{{steps.$a.deal.ownerId}}" }, subject: "s" },
                    },
                  ],
                },
              },
            ],
          },
        ],
        m,
      ),
    );
    expect(r.error.code).toBe("ref.outOfScope");
    expect(r.error.path).toBe("commands[0].steps[0].branches.else[1].config.to");
    expect((r.error.hint as { refs: unknown[] }).refs.length).toBeGreaterThan(0);
  });

  test("an unknown placeholder in a fragment fails with placeholder.unknown", () => {
    const r = fail(
      apply(
        doc(),
        [
          {
            op: "insertSteps",
            at: { start: true },
            steps: [{ type: "flow.stop", config: { reason: { $ref: "steps.$nope.x" } } }],
          },
        ],
        m,
      ),
    );
    expect(r.error.code).toBe("placeholder.unknown");
    expect(r.error.path).toBe("commands[0].steps[0].config.reason");
  });

  test("a literal of the wrong type fails with config.invalid and the field schema", () => {
    const r = fail(
      apply(
        doc(),
        [
          {
            op: "insertSteps",
            at: { start: true },
            steps: [{ type: "util.count", config: { times: "three" } }],
          },
        ],
        m,
      ),
    );
    expect(r.error.code).toBe("config.invalid");
    expect(r.error.path).toBe("commands[0].steps[0].config.times");
    expect(r.error.hint).toEqual({ expected: { type: "number" } });
  });

  test("a missing required field is accepted and reported", () => {
    const r = ok(
      apply(
        doc(),
        [{ op: "insertSteps", at: { start: true }, steps: [{ type: "util.count" }] }],
        m,
      ),
    );
    expect(r.doc.steps[0]).toEqual({ id: "count", type: "util.count", config: { label: "n" } });
    expect(r.issues.added).toContainEqual(
      expect.objectContaining({ code: "config.required", stepId: "count" }),
    );
  });

  test("rejects only on inserted steps: an existing broken ref is left alone", () => {
    const d = doc();
    (d.steps[2] as Step).config = { duration: { $ref: "steps.gone.x" } };
    ok(apply(d, [{ op: "insertSteps", at: { start: true }, steps: [{ type: "flow.stop" }] }], m));
  });

  describe("section", () => {
    test("wraps the inserted top-level run", () => {
      const r = ok(
        apply(
          doc(),
          [
            {
              op: "insertSteps",
              at: { after: "load" },
              steps: [
                { id: "s1", type: "flow.stop" },
                {
                  id: "s2",
                  type: "flow.if",
                  branches: { else: [{ id: "s3", type: "flow.stop" }] },
                },
              ],
              section: { title: "New bit", color: "green" },
            },
          ],
          m,
        ),
      );
      expect(r.doc.sections).toEqual([
        { id: "new_bit", title: "New bit", color: "green", first: "s1", last: "s2" },
      ]);
    });

    test("an explicit section ID is used", () => {
      const r = ok(
        apply(
          doc(),
          [
            {
              op: "insertSteps",
              at: { start: true },
              steps: [{ id: "s1", type: "flow.stop" }],
              section: { title: "X", color: "pink", id: "mine" },
            },
          ],
          m,
        ),
      );
      expect(r.doc.sections?.[0]?.id).toBe("mine");
    });

    test("overlapping an existing section is rejected and leaves the doc untouched", () => {
      const d = doc([sec("all", "load", "wait")]);
      const before = structuredClone(d);
      const r = fail(
        apply(
          d,
          [
            {
              op: "insertSteps",
              at: { after: "load" },
              steps: [{ type: "flow.stop" }],
              section: { title: "Inner", color: "green" },
            },
          ],
          m,
        ),
      );
      expect(r.error.code).toBe("section.overlap");
      expect(r.error.path).toBe("commands[0].section");
      expect(d).toEqual(before);
    });

    test("a section in a branch inside an outer section is fine", () => {
      const d = doc([sec("all", "load", "wait")]);
      const r = ok(
        apply(
          d,
          [
            {
              op: "insertSteps",
              at: { in: { stepId: "check", branch: "else" } },
              steps: [{ id: "s1", type: "flow.stop" }],
              section: { title: "Inner", color: "green" },
            },
          ],
          m,
        ),
      );
      expect(r.doc.sections?.map((s) => s.id)).toEqual(["all", "inner"]);
    });
  });

  describe("verbatim (paste)", () => {
    test("a step reading a later step succeeds; ref.outOfScope is reported", () => {
      const r = ok(
        apply(
          doc(),
          [
            {
              op: "insertSteps",
              at: { before: "load" },
              verbatim: true,
              steps: [
                {
                  id: "early",
                  type: "crm.sendEmail",
                  config: { to: { $ref: "steps.load.deal.ownerId" }, subject: "x" },
                },
              ],
            },
          ],
          m,
        ),
      );
      expect(top(r.doc)).toEqual(["early", "load", "check", "wait"]);
      expect(r.issues.added).toContainEqual(
        expect.objectContaining({ code: "ref.outOfScope", stepId: "early" }),
      );
    });

    test("config is kept as is: a removed default key stays removed", () => {
      const r = ok(
        apply(
          doc(),
          [
            {
              op: "insertSteps",
              at: { start: true },
              verbatim: true,
              steps: [{ id: "c", type: "util.count", config: { times: 1 } }],
            },
          ],
          m,
        ),
      );
      expect(r.doc.steps[0]).toEqual({ id: "c", type: "util.count", config: { times: 1 } });
    });

    test("an undeclared leftover branch is kept, and declared ones aren't added", () => {
      const r = ok(
        apply(
          doc(),
          [
            {
              op: "insertSteps",
              at: { start: true },
              verbatim: true,
              steps: [
                {
                  id: "x",
                  type: "flow.if",
                  config: { value: true },
                  branches: { old: [{ id: "y", type: "flow.stop", config: {} }] },
                },
              ],
            },
          ],
          m,
        ),
      );
      expect(r.doc.steps[0]?.branches).toEqual({
        old: [{ id: "y", type: "flow.stop", config: {} }],
      });
      expect(r.issues.added).toContainEqual(
        expect.objectContaining({ code: "branch.unknown", stepId: "x" }),
      );
    });

    test("an unknown node type is allowed and reported", () => {
      const r = ok(
        apply(
          doc(),
          [
            {
              op: "insertSteps",
              at: { start: true },
              verbatim: true,
              steps: [{ id: "g", type: "gone.node", config: {} }],
            },
          ],
          m,
        ),
      );
      expect(r.doc.steps[0]).toEqual({ id: "g", type: "gone.node", config: {} });
      expect(r.issues.added).toContainEqual(
        expect.objectContaining({ code: "node.unknown", stepId: "g" }),
      );
    });

    test("a taken ID fails with id.taken", () => {
      const d = doc();
      const before = structuredClone(d);
      const r = fail(
        apply(
          d,
          [
            {
              op: "insertSteps",
              at: { start: true },
              verbatim: true,
              steps: [{ id: "load", type: "flow.stop", config: {} }],
            },
          ],
          m,
        ),
      );
      expect(r.error.code).toBe("id.taken");
      expect(r.error.path).toBe("commands[0].steps[0].id");
      expect(d).toEqual(before);
    });

    test("an unknown steps.$x in a pasted config is kept, not rejected", () => {
      const r = ok(
        apply(
          doc(),
          [
            {
              op: "insertSteps",
              at: { start: true },
              verbatim: true,
              steps: [
                { id: "p", type: "flow.stop", config: { reason: { $tpl: "{{steps.$old.x}}" } } },
              ],
            },
          ],
          m,
          { trusted: true },
        ),
      );
      expect(r.doc.steps[0]?.config).toEqual({ reason: { $tpl: "{{steps.$old.x}}" } });
    });

    test("ref and section are honoured", () => {
      const r = ok(
        apply(
          doc(),
          [
            {
              op: "insertSteps",
              at: { start: true },
              verbatim: true,
              steps: [
                { ref: "a", id: "a1", type: "crm.getDeal", config: { dealId: "d" } },
                { id: "b1", type: "flow.stop", config: { reason: { $ref: "steps.$a.deal.id" } } },
              ],
              section: { title: "Pasted", color: "gray" },
            },
          ],
          m,
        ),
      );
      expect(r.doc.steps[1]?.config).toEqual({ reason: { $ref: "steps.a1.deal.id" } });
      expect(r.ids).toEqual({ $1: "a1", $a: "a1" });
      expect(r.doc.sections).toEqual([
        { id: "pasted", title: "Pasted", color: "gray", first: "a1", last: "b1" },
      ]);
    });
  });
});

describe("replaceSteps", () => {
  test("replacing b..c inside section a..d keeps the section a..d", () => {
    const r = ok(
      apply(
        flat([sec("s", "a", "d")]),
        [{ op: "replaceSteps", first: "b", last: "c", steps: [{ id: "x", type: "flow.stop" }] }],
        m,
      ),
    );
    expect(top(r.doc)).toEqual(["a", "x", "d"]);
    expect(r.doc.sections).toEqual([sec("s", "a", "d")]);
    expect(r.ids).toEqual({ $1: "x" });
  });

  test("replacing exactly a section's run makes the section span the new steps", () => {
    const r = ok(
      apply(
        flat([sec("s", "b", "c")]),
        [
          {
            op: "replaceSteps",
            first: "b",
            last: "c",
            steps: [
              { id: "x", type: "flow.stop" },
              { id: "y", type: "flow.stop" },
              { id: "z", type: "flow.stop" },
            ],
          },
        ],
        m,
      ),
    );
    expect(top(r.doc)).toEqual(["a", "x", "y", "z", "d"]);
    expect(r.doc.sections).toEqual([sec("s", "x", "z")]);
  });

  test("a single-step section replaced by a step with the same ID is kept", () => {
    const r = ok(
      apply(
        flat([sec("s", "b", "b")]),
        [{ op: "replaceSteps", first: "b", last: "b", steps: [{ id: "b", type: "flow.stop" }] }],
        m,
      ),
    );
    expect(r.doc.steps[1]).toEqual({ id: "b", type: "flow.stop", config: {} });
    expect(r.doc.sections).toEqual([sec("s", "b", "b")]);
  });

  test("new IDs may reuse the replaced steps' IDs", () => {
    const r = ok(
      apply(
        flat(),
        [
          {
            op: "replaceSteps",
            first: "b",
            last: "c",
            steps: [{ type: "flow.delay", config: { duration: "5m" } }],
          },
        ],
        m,
      ),
    );
    expect(top(r.doc)).toEqual(["a", "delay", "d"]);
  });

  test.each([
    ["reversed", "c", "b"],
    ["two lists", "load", "notify"],
  ])("a %s run fails with run.invalid", (_, first, last) => {
    const d = first === "load" ? doc() : flat();
    const before = structuredClone(d);
    const r = fail(
      apply(d, [{ op: "replaceSteps", first, last, steps: [{ type: "flow.stop" }] }], m),
    );
    expect(r.error.code).toBe("run.invalid");
    expect(r.error.path).toBe("commands[0]");
    expect(d).toEqual(before);
  });

  test("an unknown endpoint fails with step.notFound", () => {
    const r = fail(
      apply(
        flat(),
        [{ op: "replaceSteps", first: "a", last: "nope", steps: [{ type: "flow.stop" }] }],
        m,
      ),
    );
    expect(r.error.code).toBe("step.notFound");
    expect(r.error.path).toBe("commands[0].last");
  });

  test("refs elsewhere to removed steps are reported, not rejected", () => {
    const d = doc();
    (d.steps[2] as Step).config = { duration: { $ref: "steps.load.deal.id" } };
    const r = ok(
      apply(
        d,
        [
          {
            op: "replaceSteps",
            first: "load",
            last: "load",
            steps: [{ id: "s", type: "flow.stop" }],
          },
        ],
        m,
      ),
    );
    expect(r.issues.added).toContainEqual(
      expect.objectContaining({ code: "ref.unresolved", stepId: "wait" }),
    );
  });

  test("inserted steps are gated as in insertSteps", () => {
    const r = fail(
      apply(
        flat(),
        [
          {
            op: "replaceSteps",
            first: "b",
            last: "b",
            steps: [{ type: "util.count", config: { times: "x" } }],
          },
        ],
        m,
      ),
    );
    expect(r.error.code).toBe("config.invalid");
    expect(r.error.path).toBe("commands[0].steps[0].config.times");
  });
});

describe("placement rows", () => {
  const addDelay: Command = {
    op: "addStep",
    at: { after: "wait" },
    type: "flow.delay",
    config: { duration: "2m" },
  };

  test("insertSteps at { after: $1 }", () => {
    const r = ok(
      apply(
        doc(),
        [
          addDelay,
          {
            op: "insertSteps",
            at: { after: "$1" },
            steps: [{ ref: "s", type: "flow.stop", config: { reason: { $tpl: "{{steps.$1}}" } } }],
          },
        ],
        m,
      ),
    );
    expect(top(r.doc)).toEqual(["load", "check", "wait", "delay", "stop"]);
    expect(r.doc.steps[4]?.config).toEqual({ reason: { $tpl: "{{steps.delay}}" } });
    expect(r.ids).toEqual({ $1: "delay", $2: "stop", $s: "stop" });
  });

  test("replaceSteps on $1..$1", () => {
    const r = ok(
      apply(
        doc(),
        [addDelay, { op: "replaceSteps", first: "$1", last: "$1", steps: [{ type: "flow.stop" }] }],
        m,
      ),
    );
    expect(top(r.doc)).toEqual(["load", "check", "wait", "stop"]);
    expect(r.ids).toEqual({ $1: "delay", $2: "stop" });
  });

  const rows: Command[] = [
    { op: "insertSteps", at: { after: "load" }, steps: [{ type: "flow.stop" }] },
    { op: "replaceSteps", first: "wait", last: "wait", steps: [{ type: "flow.stop" }] },
  ];
  test.each(rows)("atomic: $op then a failing command leaves the input untouched", (cmd) => {
    const d = doc();
    const before = structuredClone(d);
    const r = fail(apply(d, [cmd, { op: "removeStep", id: "nope" }], m));
    expect(r.error.index).toBe(1);
    expect(r.error.path).toBe("commands[1].id");
    expect(d).toEqual(before);
  });
});

describe("a batch that fails half-way (Review Focus 2)", () => {
  test("a failing fragment after a successful insertSteps leaves the doc untouched", () => {
    const d = doc();
    const before = structuredClone(d);
    const r = fail(
      apply(
        d,
        [
          { op: "addStep", at: { start: true }, type: "crm.getDeal", config: { dealId: "d" } },
          {
            op: "insertSteps",
            at: { after: "$1" },
            steps: [
              {
                type: "flow.if",
                config: { value: true },
                branches: {
                  // biome-ignore lint/suspicious/noThenProperty: a branch ID, not a thenable
                  then: [
                    {
                      type: "crm.sendEmail",
                      config: { to: { $tpl: "{{steps.$1.deal.ownerId}}" }, subject: "s" },
                    },
                  ],
                },
              },
            ],
          },
          {
            op: "insertSteps",
            at: { after: "$2" },
            steps: [{ type: "flow.stop" }, { type: "util.count", config: { times: "x" } }],
          },
        ],
        m,
      ),
    );
    expect(r.error.index).toBe(2);
    expect(r.error.path).toBe("commands[2].steps[1].config.times");
    expect(r.error.hint).toBeDefined();
    expect(d).toEqual(before);
  });
});

describe("schema", () => {
  const cmd = {
    op: "insertSteps",
    at: { start: true },
    steps: [{ type: "flow.stop" }],
    verbatim: true,
  };

  test("verbatim is internal only", () => {
    expect(commandSchema(m, { internal: false }).safeParse(cmd).success).toBe(false);
    expect(commandSchema(m, { internal: true }).safeParse(cmd).success).toBe(true);
  });

  test("an unknown key in a nested fragment fails with command.invalid, naming it", () => {
    const r = fail(
      apply(
        doc(),
        [
          {
            op: "insertSteps",
            at: { start: true },
            steps: [
              {
                type: "flow.if",
                branches: { else: [{ type: "flow.stop", colour: "red" }] },
              },
            ],
          } as unknown as Command,
        ],
        m,
      ),
    );
    expect(r.error.code).toBe("command.invalid");
    expect(r.error.path).toBe("commands[0].steps[0].branches.else[0]");
    expect(r.error.message).toContain("colour");
    const expected = JSON.stringify((r.error.hint as { expected: unknown }).expected);
    expect(expected).toContain("disabled");
    expect(expected.length).toBeLessThanOrEqual(1500);
  });

  test("an empty steps list fails with command.invalid", () => {
    const r = fail(apply(doc(), [{ op: "insertSteps", at: { start: true }, steps: [] }], m));
    expect(r.error.code).toBe("command.invalid");
    expect(r.error.path).toBe("commands[0].steps");
  });
});
