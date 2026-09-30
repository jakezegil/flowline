import { describe, expect, test } from "vitest";
import type { JSONSchema, Manifest, WorkflowDoc } from "../types";
import {
  applyExamples,
  commandCatalog,
  readArgSchemas,
  runTool,
  type ToolDefinition,
} from "./catalog";
import { AGENT_LIMITS, commandSchema } from "./command-schema";
import { crmLikeManifest, deepDoc, flatDoc, richManifest, specExampleDoc } from "./fixtures";
import type { FollowUp, ReadToolName } from "./read-types";
import { reads } from "./reads";

const crm = crmLikeManifest();
const rich = richManifest();
/** Rich minus the switch: a loop and static branches, no `fromConfig` node. */
const noSwitch: Manifest = { ...rich, nodes: rich.nodes.filter((n) => n.type !== "flow.switch") };

const READS: ReadToolName[] = [
  "overview",
  "outline",
  "focus",
  "getSteps",
  "findSteps",
  "availableRefs",
  "listNodeTypes",
  "describeNodeTypes",
  "getIssues",
];

function tool(catalog: ToolDefinition[], name: string): ToolDefinition {
  const t = catalog.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

/** Every `Example: <json>` line of a description, parsed. */
function examples(description: string): unknown[] {
  return [...description.matchAll(/^Example: (.+)$/gm)].map((m) => JSON.parse(m[1] as string));
}

function defs(schema: JSONSchema): Record<string, JSONSchema> {
  return (schema.$defs ?? {}) as Record<string, JSONSchema>;
}

/** Every object in `v` (depth-first), with the op of the command it sits in. */
function objects(v: unknown, op?: string, out: { o: Record<string, unknown>; op?: string }[] = []) {
  if (Array.isArray(v)) {
    for (const x of v) objects(x, op, out);
  } else if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    const props = o.properties as Record<string, { const?: unknown }> | undefined;
    const own = typeof props?.op?.const === "string" ? (props.op.const as string) : op;
    out.push({ o, ...(own !== undefined ? { op: own } : {}) });
    for (const x of Object.values(o)) objects(x, own, out);
  }
  return out;
}

describe("commandCatalog", () => {
  test("names, and include", () => {
    expect(commandCatalog(crm).map((t) => t.name)).toEqual(["apply", ...READS]);
    expect(commandCatalog(crm, { include: ["reads"] }).map((t) => t.name)).toEqual(READS);
    expect(commandCatalog(crm, { include: ["commands"] }).map((t) => t.name)).toEqual(["apply"]);
  });

  test.each([
    ["crm", crm],
    ["rich", rich],
  ])("every embedded example parses (%s)", (_, m) => {
    const catalog = commandCatalog(m);
    for (const t of catalog) {
      const found = examples(t.description);
      expect(found.length, t.name).toBeGreaterThan(0);
      for (const ex of found) {
        if (t.name === "apply") {
          const cmds = (ex as { commands: unknown[] }).commands;
          expect(Array.isArray(cmds)).toBe(true);
          for (const c of cmds) {
            const r = commandSchema(m, { internal: false }).safeParse(c);
            expect(r.success, `${JSON.stringify(c)}: ${r.error?.message}`).toBe(true);
          }
        } else {
          const r = readArgSchemas[t.name as ReadToolName].safeParse(ex);
          expect(r.success, `${t.name} ${JSON.stringify(ex)}`).toBe(true);
        }
      }
    }
  });

  test("the apply description covers atomicity, placeholders, expect, templates and the report", () => {
    const d = tool(commandCatalog(crm), "apply").description;
    expect(d).toMatch(/atomic/i);
    expect(d).toContain("commands[n-1]");
    expect(d).toContain("$<ref>");
    expect(d).toContain("expect");
    expect(d).toContain('{ "$tpl": "Hi {{ trigger.contact.name }}" }');
    expect(d).toContain(
      "the result includes the changed outline and issue delta, so there's no need to re-read after success",
    );
    expect(d).toContain("~ workflow");
    expect(d).toContain("~ trigger");
    expect(d).toContain("~ output");
    expect(d).toContain('"- output" when removed');
    expect(d).toContain("- ▣ <id>");
    expect(tool(commandCatalog(crm), "focus").description).toMatch(
      /section: title, colour and note/,
    );
    expect(tool(commandCatalog(crm), "overview").description).toContain(
      "Start here. Then describeNodeTypes for any node type you'll add.",
    );
    expect(tool(commandCatalog(crm), "getSteps").description).toContain(
      "follow next until remaining is 0; if next.ids is a slice, re-request the rest of your list",
    );
    for (const name of ["focus", "getSteps"]) {
      expect(tool(commandCatalog(crm), name).description).toContain("cut");
    }
  });

  test("node type fields reference one $defs enum; setTrigger.type is the trigger enum", () => {
    for (const m of [crm, rich]) {
      const schema = tool(commandCatalog(m), "apply").inputSchema;
      expect(defs(schema).NodeType?.enum).toEqual(m.nodes.map((n) => n.type));
      const typed = objects(schema).filter(
        ({ o }) =>
          typeof o.properties === "object" && o.properties !== null && "type" in o.properties,
      );
      expect(typed.length).toBeGreaterThan(4);
      for (const { o, op } of typed) {
        const type = (o.properties as Record<string, JSONSchema>).type;
        if (op === "setTrigger") expect(type?.enum).toEqual(m.triggers.map((t) => t.type));
        else expect(type, op).toEqual({ $ref: "#/$defs/NodeType" });
      }
      const describe = tool(commandCatalog(m), "describeNodeTypes").inputSchema;
      expect(defs(describe).NodeType?.enum).toEqual(m.nodes.map((n) => n.type));
    }
  });

  test("branch fields: an enum without fromConfig nodes, else a string pointing at describeNodeTypes", () => {
    const branchOf = (m: Manifest, name = "apply") => {
      const schema = tool(commandCatalog(m), name).inputSchema;
      const s = JSON.stringify(schema);
      expect(s).toContain('"$ref":"#/$defs/Branch"');
      return defs(schema).Branch as JSONSchema;
    };
    expect(branchOf(crm).enum).toEqual(["then", "else"]);
    expect(branchOf(noSwitch).enum).toEqual(["then", "else", "body"]);
    const free = branchOf(rich);
    expect(free.enum).toBeUndefined();
    expect(free.type).toBe("string");
    expect(free.description).toContain("describeNodeTypes");
    for (const name of ["outline", "getSteps", "findSteps"]) {
      expect(branchOf(crm, name).enum).toEqual(["then", "else"]);
    }
    // Every branch-valued field in the apply schema references it.
    const apply = JSON.stringify(tool(commandCatalog(crm), "apply").inputSchema);
    expect(apply).toContain('"keep":{"$ref":"#/$defs/Branch"}');
    expect(apply).toContain('"propertyNames":{"$ref":"#/$defs/Branch"}');
  });

  test("listNodeTypes.category is the manifest's categories", () => {
    const s = tool(commandCatalog(rich), "listNodeTypes").inputSchema;
    const props = s.properties as Record<string, JSONSchema>;
    expect(props.category?.enum).toEqual(["CRM", "Marketing", "Logic"]);
  });

  test("shared pieces sit once under $defs, with no generated names", () => {
    const schema = tool(commandCatalog(crm), "apply").inputSchema;
    expect(Object.keys(defs(schema))).toEqual(
      expect.arrayContaining(["NodeType", "At", "Fragment", "ValueExpr", "Where", "Branch"]),
    );
    expect(JSON.stringify(commandCatalog(rich))).not.toContain("__schema");
  });

  test("every input schema is an object at the root (as tool APIs require)", () => {
    for (const m of [crm, rich]) {
      for (const t of commandCatalog(m)) {
        expect(t.inputSchema.type, t.name).toBe("object");
        for (const k of ["anyOf", "oneOf", "allOf"])
          expect(t.inputSchema, t.name).not.toHaveProperty(k);
      }
    }
  });

  test("each call returns a fresh copy", () => {
    const a = commandCatalog(crm);
    (a[0] as ToolDefinition).inputSchema.strict = true;
    (a[0] as ToolDefinition).description = "changed";
    const b = commandCatalog(crm);
    expect(b[0]?.inputSchema).not.toHaveProperty("strict");
    expect(b[0]?.description).not.toBe("changed");
  });

  test.each([
    ["crm", crm],
    ["rich", rich],
    ["noSwitch", noSwitch],
  ])("the apply examples run on an empty workflow with the first trigger (%s)", (_, m) => {
    const doc: WorkflowDoc = {
      id: "w",
      name: "W",
      trigger: { type: m.triggers[0]?.type as string, config: {} },
      steps: [],
    };
    let state = { doc, manifest: m };
    for (const ex of applyExamples(m)) {
      const r = runTool(state, "apply", ex);
      expect(r.ok && r.result, JSON.stringify(r)).toMatchObject({ ok: true });
      if (r.ok && r.doc) state = { ...state, doc: r.doc };
    }
    const d = tool(commandCatalog(m), "apply").description;
    expect(d).not.toMatch(/"after":|"recheck"|"notify"/);
  });

  test("plain JSON Schema: no x-flowline, $schema or internal fields", () => {
    for (const m of [crm, rich]) {
      const s = JSON.stringify(commandCatalog(m));
      expect(s).not.toContain("x-flowline");
      expect(s).not.toContain('"$schema"');
      expect(s).not.toContain("nullIsValue");
      expect(s).not.toContain("verbatim");
    }
  });
});

describe("readArgSchemas", () => {
  test("strict", () => {
    expect(readArgSchemas.overview.safeParse({ budget: 100 }).success).toBe(true);
    expect(readArgSchemas.overview.safeParse({ budgte: 100 }).success).toBe(false);
    expect(readArgSchemas.getSteps.safeParse({ ids: ["a"], where: {} }).success).toBe(false);
    expect(readArgSchemas.findSteps.safeParse({ where: { tpye: "x" } }).success).toBe(false);
  });

  test("every follow-up a read returns parses as that read's args", () => {
    const followUps: FollowUp[] = [];
    const collect = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(collect);
      else if (typeof v === "object" && v !== null) {
        const o = v as Record<string, unknown>;
        if (typeof o.tool === "string" && "args" in o) followUps.push(o as unknown as FollowUp);
        Object.values(o).forEach(collect);
      }
    };
    const docs: WorkflowDoc[] = [
      flatDoc(500, { noteChars: 800, configChars: 20_000 }),
      deepDoc(12, 60, { noteChars: 4000 }),
      specExampleDoc(),
    ];
    for (const doc of docs) {
      collect(reads.overview(doc, crm, { budget: 1500 }));
      collect(reads.outline(doc, crm, { budget: 1500 }));
      collect(reads.getSteps(doc, crm, { where: {}, include: ["config", "refs"], budget: 3000 }));
      collect(reads.findSteps(doc, crm, { where: {}, limit: 5 }));
      const first = doc.steps[0]?.id as string;
      collect(reads.focus(doc, crm, { stepId: first, budget: 500 }));
    }
    expect(followUps.length).toBeGreaterThan(5);
    for (const f of followUps) {
      const r = readArgSchemas[f.tool].safeParse(f.args);
      expect(r.success, `${f.tool} ${JSON.stringify(f.args)}`).toBe(true);
    }
  });
});

describe("runTool", () => {
  test("round trip: overview, apply, getIssues", () => {
    let doc = specExampleDoc();
    const o = runTool({ doc, manifest: crm }, "overview", {});
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    expect((o.result as { text: string }).text).toContain("getDeal");
    expect(o.doc).toBeUndefined();

    const a = runTool({ doc, manifest: crm }, "apply", {
      commands: [
        { op: "setConfig", id: "recheck", key: "value", value: true },
        { op: "addStep", at: { after: "delay_1m" }, type: "crm.sendEmail" },
      ],
    });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const result = a.result as { ok: boolean; ids: Record<string, string>; changed: string };
    expect(result.ok).toBe(true);
    expect(a.doc).toBeDefined();
    doc = a.doc as WorkflowDoc;
    const added = result.ids.$2 as string;
    expect(doc.steps.map((s) => s.id)).toContain(added);

    const i = runTool({ doc, manifest: crm }, "getIssues", { stepId: added });
    expect(i.ok).toBe(true);
    if (!i.ok) return;
    const issues = i.result as { issues: { code: string }[]; errors: number };
    expect(issues.issues.map((x) => x.code)).toContain("config.required");
    // The fixed `recheck` no longer has an issue.
    const r = runTool({ doc, manifest: crm }, "getIssues", { stepId: "recheck" });
    expect(r.ok && (r.result as { errors: number }).errors).toBe(0);
  });

  test("errors", () => {
    const state = { doc: specExampleDoc(), manifest: crm };
    const unknown = runTool(state, "deleteEverything", {});
    expect(unknown).toMatchObject({ ok: false, error: { code: "tool.unknown" } });

    const bad = runTool(state, "focus", { stepId: 3 });
    expect(bad).toMatchObject({ ok: false, error: { code: "command.invalid", path: "stepId" } });
    const extra = runTool(state, "overview", { budgte: 3 });
    expect(extra).toMatchObject({ ok: false, error: { code: "command.invalid", path: "budgte" } });

    expect(runTool(state, "apply", { commands: 3 })).toMatchObject({
      ok: false,
      error: { code: "command.invalid" },
    });
    expect(runTool(state, "apply", undefined)).toMatchObject({
      ok: false,
      error: { code: "command.invalid" },
    });

    const malformed = runTool(state, "apply", { commands: [{ op: "addStep", type: "flow.stop" }] });
    expect(malformed.ok).toBe(true);
    if (!malformed.ok) return;
    const r = malformed.result as { ok: boolean; error: { code: string; hint?: unknown } };
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("command.invalid");
    expect(r.error.hint).toBeDefined();
    expect(malformed.doc).toBeUndefined();
  });

  test("a read that rejects its arguments fails with command.invalid, a path and a hint", () => {
    const state = { doc: specExampleDoc(), manifest: crm };
    expect(runTool(state, "focus", { stepId: "getDael" })).toEqual({
      ok: false,
      error: {
        code: "command.invalid",
        message: 'focus: unknown step "getDael"',
        path: "stepId",
        hint: { closest: expect.arrayContaining(["getDeal"]) },
      },
    });
    expect(runTool(state, "findSteps", { where: { within: { stepId: "nope" } } })).toMatchObject({
      ok: false,
      error: { code: "command.invalid", path: "where.within.stepId" },
    });
    expect(runTool(state, "getSteps", { where: { section: "chek" } })).toMatchObject({
      ok: false,
      error: { path: "where.section", hint: { closest: ["check"] } },
    });
    expect(runTool(state, "outline", { stepId: "recheck", branch: "nope" })).toMatchObject({
      ok: false,
      error: { code: "command.invalid", path: "branch" },
    });
    const refs = runTool(state, "availableRefs", { stepId: "notifyOwner", path: "not a path" });
    expect(refs).toMatchObject({ ok: false, error: { path: "path" } });
    const sel = runTool(state, "findSteps", {
      where: { within: { stepId: "delay_1m", branch: "x" } },
    });
    expect(sel).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/^findSteps: /) },
    });
  });

  test("bad getSteps arguments name the field", () => {
    const state = { doc: specExampleDoc(), manifest: crm };
    const path = (args: unknown) => {
      const r = runTool(state, "getSteps", args);
      return r.ok ? "ok" : r.error.path;
    };
    expect(path({ ids: ["getDeal", 5] })).toBe("ids[1]");
    expect(path({ ids: ["getDeal"], include: ["schemas"] })).toBe("include[0]");
    expect(path({ ids: "getDeal" })).toBe("ids");
    expect(path({})).toBe("ids");
    expect(path({ ids: ["getDeal"], where: {} })).toBe("where");
    expect(path({ ids: ["getDeal"], limit: 3 })).toBe("limit");
    const both = runTool(state, "getSteps", { ids: [], where: {} });
    expect(!both.ok && both.error.message).toContain("exactly one of ids or where");
    expect(path({ where: {}, limit: 3 })).toBe("ok");
    expect(path({ ids: ["getDeal"] })).toBe("ok");
  });

  test("the apply envelope is strict", () => {
    const state = { doc: specExampleDoc(), manifest: crm };
    const r = runTool(state, "apply", {
      commands: [{ op: "renameWorkflow", name: "y" }],
      dryRun: true,
    });
    expect(r).toMatchObject({ ok: false, error: { code: "command.invalid", path: "dryRun" } });
    const schema = tool(commandCatalog(crm), "apply").inputSchema;
    expect(schema.additionalProperties).toBe(false);
  });

  test("the store-only verbatim and nullIsValue are rejected", () => {
    const state = { doc: specExampleDoc(), manifest: crm };
    const evil = runTool(state, "apply", {
      commands: [
        {
          op: "insertSteps",
          at: { start: true },
          verbatim: true,
          steps: [{ id: "evil", type: "no.such.node", config: { x: 1 }, branches: { bogus: [] } }],
        },
      ],
    });
    expect(evil.ok && evil.result).toMatchObject({ ok: false });
    // The internal field is the root cause, so it is reported first, not the fragment's node type.
    expect(evil.ok && evil.result).toMatchObject({
      error: { code: "command.invalid", message: expect.stringContaining("verbatim") },
    });
    expect(evil.ok && evil.doc).toBeFalsy();
    const verbatim = runTool(state, "apply", {
      commands: [
        { op: "insertSteps", at: { start: true }, verbatim: true, steps: [{ type: "flow.stop" }] },
      ],
    });
    expect(verbatim.ok).toBe(true);
    expect(verbatim.ok && verbatim.result).toMatchObject({
      ok: false,
      error: { code: "command.invalid", message: expect.stringContaining("verbatim") },
    });
    expect(verbatim.ok && verbatim.doc).toBeFalsy();
    const nullIsValue = runTool(state, "apply", {
      commands: [{ op: "setConfig", id: "getDeal", key: "dealId", value: null, nullIsValue: true }],
    });
    expect(nullIsValue.ok && nullIsValue.result).toMatchObject({
      ok: false,
      error: { code: "command.invalid", message: expect.stringContaining("nullIsValue") },
    });
  });

  test("a successful apply's result leaves the doc out; the doc comes back beside it", () => {
    const state = { doc: specExampleDoc(), manifest: crm };
    const r = runTool(state, "apply", { commands: [{ op: "renameWorkflow", name: "Renamed" }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result).not.toHaveProperty("doc");
    expect(r.result).toMatchObject({ ok: true, changed: expect.stringContaining("~ workflow") });
    expect(r.doc?.name).toBe("Renamed");
  });

  test("a fragment nested too deep for the stack comes back as command.invalid", () => {
    let step: Record<string, unknown> = { type: "flow.stop" };
    for (let i = 0; i < 5000; i++) step = { type: "flow.if", branches: { else: [step] } };
    const r = runTool({ doc: specExampleDoc(), manifest: crm }, "apply", {
      commands: [{ op: "insertSteps", at: { start: true }, steps: [step] }],
    });
    expect(r.ok && r.result).toMatchObject({
      ok: false,
      error: { code: "command.invalid", message: "The commands are nested too deeply to check" },
    });
  });

  test("a long unknown tool name is cut in the message", () => {
    const r = runTool({ doc: specExampleDoc(), manifest: crm }, "x".repeat(100_000), {});
    expect(!r.ok && r.error.message.length).toBeLessThan(400);
  });

  test("untrusted: unknown placeholders in config values are rejected", () => {
    const r = runTool({ doc: specExampleDoc(), manifest: crm }, "apply", {
      commands: [
        { op: "setConfig", id: "notifyOwner", key: "to", value: { $ref: "steps.$x.deal.ownerId" } },
      ],
    });
    expect(r.ok && (r.result as { ok: boolean }).ok).toBe(false);
  });
});

describe("agent limits (untrusted path)", () => {
  const doc = flatDoc(20);
  const state = { doc, manifest: crm };
  const apply = (commands: unknown[]) => runTool(state, "apply", { commands });
  const firstError = (r: ReturnType<typeof runTool>) =>
    r.ok ? (r.result as { ok: boolean; error?: { code: string; path: string } }).error : r.error;

  test(`a batch over ${AGENT_LIMITS.commands} commands is refused before any runs`, () => {
    const renames = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ op: "renameStep", id: "step_1", name: `n${i}` }));
    const over = apply(renames(AGENT_LIMITS.commands + 1));
    expect(over).toMatchObject({ ok: false, error: { code: "command.invalid", path: "commands" } });
    expect(over.ok || over.error.message).toMatch(/split the batch/);
    expect(apply(renames(AGENT_LIMITS.commands))).toMatchObject({ ok: true, result: { ok: true } });
  });

  test("names, titles and new IDs are capped", () => {
    const long = (n: number) => "a".repeat(n);
    for (const cmd of [
      { op: "renameWorkflow", name: long(AGENT_LIMITS.name + 1) },
      { op: "renameStep", id: "step_1", name: long(AGENT_LIMITS.name + 1) },
      { op: "renameStepId", id: "step_1", newId: long(AGENT_LIMITS.id + 1) },
      { op: "addStep", at: { start: true }, type: "crm.getDeal", id: long(AGENT_LIMITS.id + 1) },
      { op: "addStep", at: { start: true }, type: "crm.getDeal", note: long(4001) },
      { op: "addSection", first: "step_5", last: "step_6", title: long(201), color: "blue" },
      {
        op: "insertSteps",
        at: { start: true },
        steps: [{ type: "crm.getDeal", id: long(AGENT_LIMITS.id + 1) }],
      },
    ]) {
      expect(firstError(apply([cmd])), JSON.stringify(cmd).slice(0, 80)).toMatchObject({
        code: "command.invalid",
      });
    }
    expect(
      apply([{ op: "renameStepId", id: "step_1", newId: long(AGENT_LIMITS.id) }]),
    ).toMatchObject({ ok: true, result: { ok: true } });
  });

  test("the store's trusted schema keeps no caps", () => {
    const trusted = commandSchema(crm);
    expect(trusted.safeParse({ op: "renameWorkflow", name: "a".repeat(10_000) }).success).toBe(
      true,
    );
  });

  test("read ID lists are capped", () => {
    const ids = Array.from({ length: AGENT_LIMITS.list + 1 }, (_, i) => `x${i}`);
    expect(runTool(state, "getSteps", { ids })).toMatchObject({ ok: false });
    expect(runTool(state, "describeNodeTypes", { types: ids })).toMatchObject({ ok: false });
  });
});

describe("unknown where.type", () => {
  const state = { doc: flatDoc(5), manifest: crm };

  test("a read reports it with the closest types instead of matching nothing", () => {
    const r = runTool(state, "findSteps", { where: { type: "crm.getDeel" } });
    expect(r).toMatchObject({ ok: false, error: { code: "command.invalid", path: "where.type" } });
    expect(r.ok || r.error.hint?.closest[0]).toBe("crm.getDeal");
  });

  test("a selector command reports node.unknown instead of a silent no-op", () => {
    const r = runTool(state, "apply", {
      commands: [{ op: "removeSteps", where: { type: "crm.getDeel" }, expect: 0 }],
    });
    expect(r).toMatchObject({
      ok: true,
      result: { ok: false, error: { code: "node.unknown", path: "commands[0].where.type" } },
    });
  });

  test("a known type still matches", () => {
    expect(runTool(state, "findSteps", { where: { type: "crm.getDeal" } })).toMatchObject({
      ok: true,
    });
  });
});
