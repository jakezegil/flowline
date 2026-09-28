import { describe, expect, test } from "vitest";
import { z } from "zod";
import { branch, defineNode, definePlugin, defineTrigger, stop } from "./define";
import {
  blockedUrlProblem,
  emailProblem,
  isPrivateHost,
  literalUrlHost,
  unreachableSteps,
} from "./design-checks";
import { createRegistry } from "./registry";
import { availableScope, describeSubflowOutput } from "./scope";
import type { Step, WorkflowDoc } from "./types";
import { fields, ui } from "./ui";
import { validateWorkflow } from "./validate";

const email = defineNode({
  type: "t.email",
  name: "Send email",
  input: z.object({
    to: ui(z.string().meta({ format: "email" }), { label: "To" }),
    subject: z.string().optional(),
  }),
  run: () => ({}),
});
const http = defineNode({
  type: "t.http",
  name: "HTTP",
  input: z.object({ url: ui(z.string(), { label: "URL", outboundUrl: true }) }),
  run: () => ({}),
});
const halt = defineNode({
  type: "t.stop",
  name: "Stop",
  endsRun: true,
  input: z.object({}),
  run: () => stop(),
});
const person = defineNode({
  type: "t.person",
  name: "Person",
  input: z.object({ firstName: z.string(), api_key: z.string() }),
  run: () => ({}),
});
const noop = defineNode({ type: "t.noop", name: "Noop", input: z.object({}), run: () => ({}) });
const ifElse = defineNode({
  type: "t.if",
  name: "If",
  input: z.object({}),
  branches: {
    kind: "static",
    branches: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
  },
  run: () => branch("yes"),
});
const loop = defineNode({
  type: "t.loop",
  name: "Loop",
  input: z.object({ items: z.array(z.unknown()) }),
  branches: { kind: "loop", itemsField: "items", branch: "body" },
  run: () => ({}),
});
const load = defineNode({
  type: "t.load",
  name: "Load",
  input: z.object({}),
  output: z.object({ contact: z.object({ id: z.string(), email: z.string() }) }),
  run: () => ({ contact: { id: "c", email: "e" } }),
});
const manual = defineTrigger({
  type: "t.manual",
  name: "Manual",
  kind: "manual",
  config: z.object({}),
  payload: z.object({}),
});
const sub = defineTrigger({
  type: "t.subflow",
  name: "Sub-flow",
  kind: "subflow",
  config: z.object({ input: fields().optional(), output: fields().optional() }),
});
const hidden = defineTrigger({
  type: "t.hook",
  name: "Hook",
  kind: "webhook",
  config: z.object({
    declare: z.boolean().default(false),
    body: ui(fields(), { showIf: { field: "declare", equals: true } }).optional(),
  }),
  dynamicPayload: { kind: "webhook", configPath: "body" },
});
const manifest = createRegistry([
  definePlugin({
    id: "t",
    name: "T",
    nodes: [email, http, halt, noop, ifElse, loop, load, person],
    triggers: [manual, sub, hidden],
  }),
]).manifest();

const s = (id: string, type: string, config: Step["config"] = {}, branches?: Step["branches"]) =>
  ({ id, type, config, ...(branches ? { branches } : {}) }) as Step;
const doc = (steps: Step[], trigger = { type: "t.manual", config: {} }): WorkflowDoc => ({
  id: "wf",
  name: "Wf",
  trigger,
  steps,
});

describe("email fields", () => {
  test("literal addresses are checked; empty and valid pass", () => {
    expect(emailProblem("dev@acme.test")).toBeUndefined();
    expect(emailProblem("")).toBeUndefined();
    expect(emailProblem("dev@acme")).toBe("isn't a valid email address");
    expect(emailProblem("dev@acme.testEnterprise lead approved")).toBe(
      "isn't a valid email address",
    );
  });

  test("a template gluing words to a reference is flagged; a built address is not", () => {
    expect(emailProblem({ $tpl: "{{steps.a.email}}Enterprise lead approved" })).toContain(
      '("Enterprise lead approved")',
    );
    expect(emailProblem({ $tpl: "{{steps.a.first}}.{{steps.a.last}}@acme.com" })).toBeUndefined();
    expect(emailProblem({ $tpl: "{{steps.a.email}} {{steps.b.email}}" })).toContain("spaces");
  });

  test("the validator warns on the field (H1's To), never errors", () => {
    const issues = validateWorkflow(
      doc([s("mail", "t.email", { to: "dev@acme.testEnterprise lead approved" })]),
      manifest,
    );
    expect(issues).toEqual([
      expect.objectContaining({
        code: "config.format",
        severity: "warning",
        stepId: "mail",
        field: "to",
        message: `"To" isn't a valid email address`,
      }),
    ]);
  });
});

describe("outbound URLs", () => {
  test("literal hosts are parsed; a host a reference could extend is not", () => {
    expect(literalUrlHost("http://localhost:8911/api")).toBe("localhost");
    expect(literalUrlHost("https://user:pw@[::1]/x")).toBe("::1");
    expect(literalUrlHost("http://10.0.0.5", false)).toBeUndefined();
    expect(literalUrlHost("http://10.0.0.5/", false)).toBe("10.0.0.5");
    expect(literalUrlHost("/relative")).toBeUndefined();
  });

  test("private, loopback and link-local hosts", () => {
    for (const h of [
      "localhost",
      "api.localhost",
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ])
      expect(isPrivateHost(h), h).toBe(true);
    for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "2001:db8::1"])
      expect(isPrivateHost(h), h).toBe(false);
  });

  test("M17: a literal localhost URL warns, including in a template; policy can allow it", () => {
    expect(blockedUrlProblem("http://localhost:8911/api", undefined)).toContain(
      "private or loopback",
    );
    expect(blockedUrlProblem({ $tpl: "http://localhost:8911/api/{{loop.item}}" }, {})).toContain(
      "localhost",
    );
    expect(blockedUrlProblem("https://api.example.com/x", undefined)).toBeUndefined();
    expect(blockedUrlProblem("http://localhost/x", { allowPrivateNetworks: true })).toBeUndefined();
    expect(blockedUrlProblem("https://evil.test/", { allowHosts: ["api.example.com"] })).toContain(
      "isn't one of the hosts",
    );
    const issues = validateWorkflow(
      doc([
        s("load", "t.load"),
        s("call", "t.http", {
          url: { $tpl: "http://localhost:8911/api/{{steps.load.contact.id}}" },
        }),
      ]),
      manifest,
    );
    expect(issues).toEqual([
      expect.objectContaining({ code: "network.blocked", severity: "warning", field: "url" }),
    ]);
    const allowed = validateWorkflow(
      doc([s("call", "t.http", { url: "http://localhost/x" })]),
      manifest,
      { network: { allowPrivateNetworks: true } },
    );
    expect(allowed).toEqual([]);
  });
});

describe("unreachable steps (M8)", () => {
  test("steps after a Stop in the same list", () => {
    const d = doc([s("a", "t.noop"), s("end", "t.stop"), s("b", "t.noop"), s("c", "t.noop")]);
    expect(unreachableSteps(d, manifest)).toEqual([{ endsAt: "end", stepIds: ["b", "c"] }]);
    expect(validateWorkflow(d, manifest)).toEqual([
      expect.objectContaining({
        code: "step.unreachable",
        severity: "warning",
        stepId: "end",
        message: "2 steps after this can never run: the run always ends here",
      }),
    ]);
  });

  test("a Stop in one branch ends only that branch; in every branch, the block", () => {
    const one = doc([
      s("if", "t.if", {}, { yes: [s("stop1", "t.stop")], no: [] }),
      s("after", "t.noop"),
    ]);
    expect(unreachableSteps(one, manifest)).toEqual([]);
    const both = doc([
      s("if", "t.if", {}, { yes: [s("stop1", "t.stop")], no: [s("stop2", "t.stop")] }),
      s("after", "t.noop", {}),
      s("loop", "t.loop", { items: [] }, { body: [s("inner", "t.noop")] }),
    ]);
    expect(unreachableSteps(both, manifest)).toEqual([
      { endsAt: "if", stepIds: ["after", "loop", "inner"] },
    ]);
    expect(validateWorkflow(both, manifest)).toContainEqual(
      expect.objectContaining({
        code: "step.unreachable",
        stepId: "if",
        message: "3 steps after this can never run: every path through this step ends the run",
      }),
    );
  });

  test("loops, disabled Stops and trailing Stops don't count", () => {
    const d = doc([
      s("loop", "t.loop", { items: [] }, { body: [s("stopIn", "t.stop"), s("dead", "t.noop")] }),
      s("live", "t.noop"),
      { ...s("off", "t.stop"), disabled: true },
      s("live2", "t.noop"),
      s("last", "t.stop"),
    ]);
    expect(unreachableSteps(d, manifest)).toEqual([{ endsAt: "stopIn", stepIds: ["dead"] }]);
  });
});

describe("scope (R3-M1, M2)", () => {
  test("trigger payload declarations hidden by showIf aren't in scope", () => {
    const body = [{ name: "email", type: "string" as const }];
    const off = doc([s("a", "t.noop")], { type: "t.hook", config: { body } });
    const on = doc([s("a", "t.noop")], { type: "t.hook", config: { declare: true, body } });
    const payload = (d: WorkflowDoc) => availableScope(d, "a", manifest)[0]?.schema;
    expect(JSON.stringify(payload(off))).not.toContain('"email"');
    expect(JSON.stringify(payload(on))).toContain('"email"');
  });

  test("a sub-flow's declared object output takes the mapped reference's shape", () => {
    const child: WorkflowDoc = {
      ...doc([s("load", "t.load")], {
        type: "t.subflow",
        config: {
          output: [
            { name: "contact", type: "object", required: true, description: "The contact." },
            { name: "extra", type: "object" },
          ],
        },
      }),
      output: { contact: { $ref: "steps.load.contact" }, extra: { $tpl: "x" } },
    };
    const out = describeSubflowOutput(child, manifest);
    const props = out?.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys((props.contact?.properties ?? {}) as object)).toEqual(["id", "email"]);
    expect(props.contact?.description).toBe("The contact.");
    expect(props.extra).toEqual({ type: "object" });
    expect(out?.required).toEqual(["contact"]);
    expect(describeSubflowOutput(doc([]), manifest)).toBeUndefined();
  });
});

describe("messages (L1)", () => {
  test("an unlabelled field is named in words, as the editor labels it", () => {
    const messages = validateWorkflow(doc([s("p", "t.person")]), manifest).map((i) => i.message);
    expect(messages).toEqual(['"First name" is required', '"API key" is required']);
  });
});
