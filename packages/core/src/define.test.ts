import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import {
  branch,
  defineNode,
  definePlugin,
  defineTrigger,
  FLOWKIT_SIGNAL,
  FlowkitDefinitionError,
  invokeSubflow,
  isSignal,
  loop,
  type NodeContext,
  type NodeDefinition,
  type Signal,
  stop,
  suspend,
} from "./define";
import { fieldsToJsonSchema } from "./json-schema";
import type { FieldDecl } from "./types";
import { fields, secret, sensitive, ui } from "./ui";

describe("defineNode", () => {
  test("infers run input from the input schema", () => {
    const node = defineNode({
      type: "crm.loadContact",
      name: "Load contact",
      input: z.object({
        contactId: ui(z.string(), { label: "Contact" }),
        limit: z.number().default(10),
        tag: z.string().optional(),
      }),
      output: z.object({ id: z.string() }),
      run: ({ input, ctx }) => {
        expectTypeOf(input.contactId).toEqualTypeOf<string>();
        expectTypeOf(input.limit).toEqualTypeOf<number>();
        expectTypeOf(input.tag).toEqualTypeOf<string | undefined>();
        expectTypeOf(ctx).toEqualTypeOf<NodeContext>();
        return { id: input.contactId };
      },
    });
    expect(node.type).toBe("crm.loadContact");
  });

  test("run return type is checked against the declared output", () => {
    defineNode({
      type: "crm.x",
      name: "X",
      input: z.object({}),
      output: z.object({ id: z.string() }),
      // @ts-expect-error — `id` must be a string
      run: () => ({ id: 1 }),
    });
    const missing = defineNode({
      type: "crm.z",
      name: "Z",
      input: z.object({}),
      output: z.object({ id: z.string(), email: z.string() }),
      // @ts-expect-error — `email` is required by the output schema
      run: () => ({ id: "a" }),
    });
    expectTypeOf(missing.output).toEqualTypeOf<
      z.ZodType<{ id: string; email: string }, { id: string; email: string }> | undefined
    >();
    defineNode({
      type: "crm.y",
      name: "Y",
      input: z.object({}),
      output: z.object({ id: z.string() }),
      run: async () => branch("if", { id: "a" }),
    });
    defineNode({
      type: "crm.w",
      name: "W",
      input: z.object({}),
      output: z.object({ id: z.string() }),
      // @ts-expect-error — branch output `id` must be a string
      run: () => branch("if", { id: 1 }),
    });
    defineNode({
      type: "crm.v",
      name: "V",
      input: z.object({}),
      output: z.object({ id: z.string() }),
      // @ts-expect-error — branch output is missing `id`
      run: async () => branch("else", {}),
    });
  });

  test("run returns the output schema's input type (defaults may be omitted)", () => {
    const input = z.object({});
    const node = defineNode({
      type: "crm.d",
      name: "D",
      input,
      output: z.object({ id: z.string(), tags: z.array(z.string()).default([]) }),
      run: () => ({ id: "a" }),
    });
    // O is the parsed (output) type, used for typed references downstream
    expectTypeOf(node).toEqualTypeOf<
      NodeDefinition<
        typeof input,
        { id: string; tags: string[] },
        { id: string; tags?: string[] | undefined }
      >
    >();
    defineNode({
      type: "crm.e",
      name: "E",
      input: z.object({}),
      output: z.object({ id: z.string(), tags: z.array(z.string()).default([]) }),
      // @ts-expect-error — `tags` may be omitted but must be a string[] when given
      run: () => ({ id: "a", tags: [1] }),
    });
  });

  test("accepts strict and loose object schemas", () => {
    defineNode({ type: "a.b", name: "B", input: z.strictObject({ a: z.string() }), run: () => 1 });
    defineNode({ type: "a.c", name: "C", input: z.looseObject({ a: z.string() }), run: () => 1 });
  });

  test("without output, stores no output schema and run may return anything", () => {
    const node = defineNode({
      type: "a.b",
      name: "B",
      input: z.object({}),
      run: () => ({ anything: 1 }),
    });
    expect(node.output).toBeUndefined();
    expect("output" in node).toBe(false);
  });

  test("keeps dynamicOutput without adding a static output", () => {
    const node = defineNode({
      type: "a.b",
      name: "B",
      input: z.object({ fields: fields() }),
      dynamicOutput: { kind: "fields", configPath: "fields" },
      run: () => ({}),
    });
    expect(node.output).toBeUndefined();
    expect(node.dynamicOutput).toEqual({ kind: "fields", configPath: "fields" });
  });

  test("rejects a type without a namespace", () => {
    expect(() =>
      defineNode({ type: "load", name: "L", input: z.object({}), run: () => 1 }),
    ).toThrow(FlowkitDefinitionError);
    expect(() =>
      defineNode({ type: ".load", name: "L", input: z.object({}), run: () => 1 }),
    ).toThrow(/namespace/);
  });

  test("rejects output and dynamicOutput together", () => {
    expect(() =>
      defineNode({
        type: "a.b",
        name: "B",
        input: z.object({}),
        output: z.object({}),
        dynamicOutput: { kind: "fields", configPath: "f" },
        run: () => ({}),
      }),
    ).toThrow(/output.*dynamicOutput/);
  });
});

describe("defineTrigger", () => {
  test("types filter args from config and payload", () => {
    const t = defineTrigger({
      type: "crm.dealUpdated",
      name: "Deal updated",
      kind: "event",
      event: "deal.updated",
      config: z.object({ onlyStage: z.boolean().default(false) }),
      payload: z.object({ changes: z.array(z.string()) }),
      filter: ({ config, payload }) => {
        expectTypeOf(config.onlyStage).toEqualTypeOf<boolean>();
        expectTypeOf(payload.changes).toEqualTypeOf<string[]>();
        return !config.onlyStage || payload.changes.includes("stage");
      },
    });
    expect(t.filter?.({ config: { onlyStage: true }, payload: { changes: ["stage"] } })).toBe(true);
  });

  test("rejects a type without a namespace and payload + dynamicPayload", () => {
    expect(() =>
      defineTrigger({ type: "manual", name: "M", kind: "manual", config: z.object({}) }),
    ).toThrow(FlowkitDefinitionError);
    expect(() =>
      defineTrigger({
        type: "a.b",
        name: "M",
        kind: "webhook",
        config: z.object({}),
        payload: z.object({}),
        dynamicPayload: { kind: "webhook", configPath: "fields" },
      }),
    ).toThrow(/payload.*dynamicPayload/);
  });
});

describe("definePlugin", () => {
  test("returns the definition", () => {
    const p = definePlugin({ id: "crm", name: "CRM" });
    expect(p).toEqual({ id: "crm", name: "CRM" });
  });
});

describe("signals", () => {
  test("isSignal recognises every signal and nothing else", () => {
    expect(isSignal(branch("if"))).toBe(true);
    expect(isSignal(suspend({ until: 5 }))).toBe(true);
    expect(isSignal(stop("done"))).toBe(true);
    expect(isSignal(invokeSubflow({ workflowId: "wf", input: {} }))).toBe(true);
    expect(isSignal(loop([1, 2]))).toBe(true);
    expect(isSignal({})).toBe(false);
    expect(isSignal(null)).toBe(false);
    expect(isSignal("branch")).toBe(false);
    expect(isSignal({ kind: "branch", branch: "if" })).toBe(false);
  });

  test("loop carries its items", () => {
    expect(loop(["a", "b"])).toMatchObject({ kind: "loop", items: ["a", "b"] });
  });

  test("the signal key survives duplicated package copies", () => {
    expect(FLOWKIT_SIGNAL).toBe(Symbol.for("flowkit.signal"));
    const foreign = { [Symbol.for("flowkit.signal")]: true, kind: "stop" };
    expect(isSignal(foreign)).toBe(true);
  });

  test("signals carry their payload and narrow on kind", () => {
    const handle = { token: "t", resumeUrl: "https://x/resume/t", expiresAt: 9 };
    const signals: Signal[] = [
      branch("else", { n: 1 }),
      suspend({ callback: handle }),
      stop(),
      invokeSubflow({ workflowId: "wf", input: 1 }),
    ];
    expect(signals.map((s) => s.kind)).toEqual(["branch", "suspend", "stop", "subflow"]);
    const b = signals[0]!;
    if (b.kind === "branch") {
      expect(b.branch).toBe("else");
      expect(b.output).toEqual({ n: 1 });
    }
    expect(signals[1]).toMatchObject({ kind: "suspend", callback: handle });
    expect(suspend({ until: 42 })).toMatchObject({ kind: "suspend", until: 42 });
    expect(stop("why")).toMatchObject({ kind: "stop", reason: "why" });
    expectTypeOf(branch("x", { a: 1 }).output).toEqualTypeOf<{ a: number }>();
  });
});

describe("ui helpers", () => {
  const json = (s: z.ZodType) => z.toJSONSchema(s, { io: "input", unrepresentable: "any" });

  test("ui returns the same schema type and attaches x-flowkit", () => {
    const s = ui(z.string().min(1), { label: "Name" });
    expectTypeOf(s).toEqualTypeOf<z.ZodString>();
    expect(json(s)).toMatchObject({ type: "string", minLength: 1, "x-flowkit": { label: "Name" } });
  });

  test("ui merges with metadata from an earlier ui call", () => {
    const s = ui(ui(z.string(), { label: "A", group: "g" }), { widget: "w", group: "h" });
    expect(json(s)["x-flowkit"]).toEqual({ label: "A", widget: "w", group: "h" });
  });

  test("ui does not mutate a reused base schema", () => {
    const base = z.string();
    const a = ui(base, { label: "A" });
    const b = ui(base, { label: "B" });
    expect(json(a)["x-flowkit"]).toEqual({ label: "A" });
    expect(json(b)["x-flowkit"]).toEqual({ label: "B" });
    expect(json(base)["x-flowkit"]).toBeUndefined();
  });

  test("secret, sensitive and fields", () => {
    expect(json(secret())["x-flowkit"]).toEqual({ secret: true, widget: "secret" });
    expect(json(secret(z.string().min(3)))).toMatchObject({ minLength: 3 });
    expect(json(sensitive(z.number()))["x-flowkit"]).toEqual({ sensitive: true });
    const f = fields();
    expect(json(f)["x-flowkit"]).toEqual({ widget: "fields" });
    expect(f.parse([{ name: "a", type: "date", required: true }])).toEqual([
      { name: "a", type: "date", required: true },
    ]);
    expectTypeOf<z.infer<typeof f>>().toEqualTypeOf<FieldDecl[]>();
    expect(f.safeParse([{ name: "a", type: "uuid" }]).success).toBe(false);
    expect(f.safeParse([{ name: "has space", type: "string" }]).success).toBe(false);
  });
});

describe("fieldsToJsonSchema", () => {
  test("date maps to date-time strings and required is collected", () => {
    expect(fieldsToJsonSchema([{ name: "a", type: "date", required: true }])).toEqual({
      type: "object",
      properties: { a: { type: "string", format: "date-time" } },
      required: ["a"],
      additionalProperties: true,
    });
  });

  test("maps every field type and carries descriptions", () => {
    expect(
      fieldsToJsonSchema([
        { name: "s", type: "string", description: "S" },
        { name: "n", type: "number" },
        { name: "b", type: "boolean" },
        { name: "o", type: "object" },
        { name: "l", type: "array" },
      ]),
    ).toEqual({
      type: "object",
      properties: {
        s: { type: "string", description: "S" },
        n: { type: "number" },
        b: { type: "boolean" },
        o: { type: "object" },
        l: { type: "array" },
      },
      additionalProperties: true,
    });
  });
});
