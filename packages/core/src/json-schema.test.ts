import { describe, expect, test } from "vitest";
import { z } from "zod";
import { manifest, step } from "../test/fixtures";
import {
  branchesFor,
  checkFields,
  describeType,
  fieldsToJsonSchema,
  isAssignable,
  outputSchemaFor,
  payloadSchemaFor,
  schemaAtPath,
} from "./json-schema";
import type { JSONSchema, NodeManifest, TriggerManifest } from "./types";

const node = (type: string) => manifest.nodes.find((n) => n.type === type) as NodeManifest;
const trig = (type: string) => manifest.triggers.find((t) => t.type === type) as TriggerManifest;
const contact = (node("crm.loadContact").output as { schema: JSONSchema }).schema;

describe("schemaAtPath", () => {
  test("follows properties, items and nullable unions", () => {
    expect(schemaAtPath(contact, ["email"])).toMatchObject({ type: "string" });
    expect(schemaAtPath(contact, ["tags", 0])).toMatchObject({ type: "string" });
    expect(schemaAtPath(contact, ["orders", 3, "total"])).toMatchObject({ type: "number" });
    expect(schemaAtPath(contact, ["address", "city"])).toMatchObject({ type: "string" });
    expect(schemaAtPath(contact, [])).toBe(contact);
  });

  test("missing key in a closed object is undefined; open objects are lenient", () => {
    expect(schemaAtPath(contact, ["emial"])).toBeUndefined();
    expect(schemaAtPath(contact, ["email", "x"])).toBeUndefined();
    expect(schemaAtPath({ type: "object", properties: {} }, ["x"])).toEqual({});
    expect(
      schemaAtPath({ type: "object", additionalProperties: { type: "number" } }, ["k"]),
    ).toEqual({ type: "number" });
  });

  test("{} is any: every path resolves to {}", () => {
    expect(schemaAtPath({}, ["a", 0, "b"])).toEqual({});
    expect(schemaAtPath({ type: "object", properties: { a: {} } }, ["a", "b"])).toEqual({});
  });

  test("resolves $defs references", () => {
    const s: JSONSchema = {
      type: "object",
      properties: {
        a: { $ref: "#/$defs/Addr" },
        list: { type: "array", items: { $ref: "#/$defs/Addr" } },
      },
      additionalProperties: false,
      $defs: {
        Addr: {
          type: "object",
          properties: { city: { type: "string" } },
          additionalProperties: false,
        },
      },
    };
    expect(schemaAtPath(s, ["a", "city"])).toEqual({ type: "string" });
    expect(schemaAtPath(s, ["list", 0, "city"])).toEqual({ type: "string" });
    expect(schemaAtPath(s, ["a", "nope"])).toBeUndefined();
    // Returned subschemas stay self-contained
    const list = schemaAtPath(s, ["list"]) as JSONSchema;
    expect(schemaAtPath(list, [0, "city"])).toEqual({ type: "string" });
  });
});

describe("isAssignable", () => {
  const S = { type: "string" };
  const N = { type: "number" };
  test.each<[string, JSONSchema, JSONSchema, boolean]>([
    ["string→string", S, S, true],
    ["any→string", {}, S, true],
    ["string→any", S, {}, true],
    ["number→string (coercion)", N, S, true],
    ["integer→number", { type: "integer" }, N, true],
    ["string→number", S, N, false],
    ["object→string", { type: "object" }, S, false],
    ["enum→string", { type: "string", enum: ["a"] }, S, true],
    [
      "enum subset→enum",
      { type: "string", enum: ["a"] },
      { type: "string", enum: ["a", "b"] },
      true,
    ],
    [
      "enum disjoint→enum",
      { type: "string", enum: ["c"] },
      { type: "string", enum: ["a", "b"] },
      false,
    ],
    ["nullable string→string", { type: ["string", "null"] }, S, true],
    ["anyOf nullable→string", { anyOf: [S, { type: "null" }] }, S, true],
    ["string→nullable", S, { anyOf: [S, { type: "null" }] }, true],
    ["string[]→string[]", { type: "array", items: S }, { type: "array", items: S }, true],
    [
      "object[]→string[]",
      { type: "array", items: { type: "object" } },
      { type: "array", items: S },
      false,
    ],
    ["array→string", { type: "array", items: S }, S, false],
    ["array→array(any)", { type: "array", items: S }, { type: "array" }, true],
  ])("%s", (_name, from, to, expected) => {
    expect(isAssignable(from, to)).toBe(expected);
  });

  test("objects: property types checked structurally", () => {
    const to = { type: "object", properties: { id: S }, required: ["id"] };
    expect(isAssignable(contact, to)).toBe(true);
    expect(
      isAssignable({ type: "object", properties: { id: N }, additionalProperties: false }, to),
    ).toBe(
      true, // number→string coerces
    );
    expect(isAssignable({ type: "object", properties: { id: { type: "object" } } }, to)).toBe(
      false,
    );
    expect(
      isAssignable({ type: "object", properties: { x: S }, additionalProperties: false }, to),
    ).toBe(false);
  });
});

describe("describeType", () => {
  test.each<[JSONSchema, string]>([
    [{}, "any"],
    [{ type: "string" }, "string"],
    [{ type: "integer" }, "number"],
    [{ type: "array", items: { type: "number" } }, "number[]"],
    [{ type: "array" }, "any[]"],
    [{ type: "object", properties: { id: {}, email: {} } }, "{ id, email }"],
    [{ type: "object" }, "object"],
    [{ type: ["string", "null"] }, "string"],
    [{ type: "string", format: "date-time" }, "date"],
    [{ type: "string", enum: ["a", "b"] }, '"a" | "b"'],
    [{ anyOf: [{ type: "string" }, { type: "number" }] }, "string | number"],
  ])("%j → %s", (schema, expected) => {
    expect(describeType(schema)).toBe(expected);
  });
});

describe("outputSchemaFor / payloadSchemaFor / branchesFor", () => {
  test("schema output is returned as-is; undeclared output is {}", () => {
    expect(outputSchemaFor(node("crm.loadContact"), step("a", "crm.loadContact"), {})).toBe(
      contact,
    );
    expect(outputSchemaFor(node("test.untyped"), step("a", "test.untyped"), {})).toEqual({});
  });

  test("fields output is built from config", () => {
    const decl = [{ name: "total", type: "number" as const, required: true }];
    expect(
      outputSchemaFor(node("test.fields"), step("a", "test.fields", { fields: decl }), {}),
    ).toEqual(fieldsToJsonSchema(decl));
    expect(
      outputSchemaFor(
        node("test.fields"),
        step("a", "test.fields", { fields: { $ref: "trigger" } }),
        {},
      ),
    ).toEqual({});
  });

  test("subflow output comes from the context", () => {
    const out = { type: "object", properties: { ok: { type: "boolean" } } };
    const ctx = { subflows: { child: { name: "Child", input: {}, output: out } } };
    expect(
      outputSchemaFor(node("test.sub"), step("a", "test.sub", { workflowId: "child" }), ctx),
    ).toBe(out);
    expect(
      outputSchemaFor(node("test.sub"), step("a", "test.sub", { workflowId: "nope" }), ctx),
    ).toEqual({});
  });

  test("trigger payloads: schema, fields, webhook, undeclared", () => {
    expect(
      payloadSchemaFor(trig("crm.contactCreated"), { type: "crm.contactCreated", config: {} }),
    ).toMatchObject({
      type: "object",
    });
    const decl = [{ name: "q", type: "string" as const }];
    expect(
      payloadSchemaFor(trig("test.manual"), { type: "test.manual", config: { fields: decl } }),
    ).toEqual(fieldsToJsonSchema(decl));
    const hook = payloadSchemaFor(trig("test.hook"), {
      type: "test.hook",
      config: { fields: decl },
    });
    expect(schemaAtPath(hook, ["body", "q"])).toEqual({ type: "string" });
    expect(schemaAtPath(hook, ["headers", "x-id"])).toEqual({ type: "string" });
    expect(payloadSchemaFor(trig("test.any"), { type: "test.any", config: {} })).toEqual({});
  });

  test("branches: none, static, fromConfig + append, loop", () => {
    expect(branchesFor(node("crm.sendEmail"), step("a", "crm.sendEmail"))).toEqual([]);
    expect(branchesFor(node("test.ifElse"), step("a", "test.ifElse")).map((b) => b.id)).toEqual([
      "yes",
      "no",
    ]);
    const sw = step("a", "test.switch", {
      cases: [
        { id: "vip", label: "VIP", value: "v" },
        { id: "std", label: "Standard", value: "s" },
      ],
    });
    expect(branchesFor(node("test.switch"), sw)).toEqual([
      { id: "vip", label: "VIP" },
      { id: "std", label: "Standard" },
      { id: "default", label: "Default" },
    ]);
    expect(branchesFor(node("test.each"), step("a", "test.each"))).toEqual([
      { id: "body", label: "Body" },
    ]);
  });
});

describe("real Zod output", () => {
  test("$defs from ids and recursive schemas resolve", () => {
    const Addr = z.object({ city: z.string() }).meta({ id: "Addr" });
    const Node: z.ZodType<{ name: string; children: unknown[] }> = z.object({
      name: z.string(),
      get children() {
        return z.array(Node);
      },
    });
    const s = z.toJSONSchema(z.object({ home: Addr, work: Addr, tree: Node }), {
      io: "output",
    }) as JSONSchema;
    expect(schemaAtPath(s, ["work", "city"])).toMatchObject({ type: "string" });
    expect(schemaAtPath(s, ["tree", "children", 0, "children", 1, "name"])).toMatchObject({
      type: "string",
    });
    expect(schemaAtPath(s, ["tree", "nope"])).toBeUndefined();
    expect(isAssignable(schemaAtPath(s, ["home"])!, { type: "string" })).toBe(false);
    expect(describeType(schemaAtPath(s, ["tree", "children"])!)).toBe("{ name, children }[]");
  });
});

describe("checkFields", () => {
  const fields = [
    { name: "email", type: "string", required: true },
    { name: "age", type: "number" },
    { name: "vip", type: "boolean" },
    { name: "address", type: "object" },
    { name: "tags", type: "array" },
    { name: "born", type: "date" },
  ] as const;

  test("accepts matching values, missing optional fields and extra properties", () => {
    expect(checkFields([...fields], { email: "a@x.test" })).toBeUndefined();
    expect(
      checkFields([...fields], {
        email: "a@x.test",
        age: 3,
        vip: false,
        address: { city: "x" },
        tags: [],
        born: "2020-01-02T03:04:05Z",
        extra: 1,
      }),
    ).toBeUndefined();
  });

  test("names the first missing required field or mistyped value", () => {
    expect(checkFields([...fields], {})).toBe('field "email" is required');
    expect(checkFields([...fields], { email: 1 })).toBe('field "email" must be of type string');
    expect(checkFields([...fields], { email: "a", age: Number.NaN })).toBe(
      'field "age" must be of type number',
    );
    expect(checkFields([...fields], { email: "a", address: [] })).toBe(
      'field "address" must be of type object',
    );
    expect(checkFields([...fields], { email: "a", born: "yesterday" })).toBe(
      'field "born" must be of type date',
    );
  });

  test("requires an object and ignores malformed declarations", () => {
    expect(checkFields([], [])).toBe("must be an object");
    expect(checkFields([], null)).toBe("must be an object");
    const malformed = [{ name: "x", type: "nope" }, null] as never;
    expect(checkFields(malformed, { x: 1 })).toBeUndefined();
  });
});
