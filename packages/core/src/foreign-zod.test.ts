/**
 * Ruling 73: a schema built by a second copy of zod whose flowline metadata core can't read is a
 * definition error, never a silently dropped secret()/sensitive() guard.
 */
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod/v3";
import { defineNode, definePlugin, FlowlineDefinitionError } from "./define";
import { createRegistry } from "./registry";
import { secret, sensitive, ui } from "./ui";

/**
 * A stand-in for a schema built by another zod copy (e.g. the host's, next to a `link:`ed
 * flowline's): its `.meta()` reads that copy's own registry, which core's zod never sees.
 */
function fromForeignZod<T extends z.ZodType>(
  schema: T,
  meta: Record<string, unknown>,
  version: { major: number; minor: number; patch: number } = { major: 4, minor: 1, patch: 0 },
): T {
  const copy = schema.clone() as T;
  const registry = z.registry<Record<string, unknown>>();
  registry.add(copy, meta);
  Object.defineProperty(copy, "meta", { value: () => registry.get(copy) });
  (copy._zod as { version: unknown }).version = version;
  return copy;
}

const nodeWith = (input: z.ZodObject) =>
  createRegistry([
    definePlugin({
      id: "host",
      name: "Host",
      nodes: [defineNode({ type: "host.call", name: "Call", input, run: () => ({}) })],
    }),
  ]);

describe("schemas from a different zod copy", () => {
  const secretMeta = { "x-flowline": { secret: true, widget: "secret", literalOnly: true } };

  test("a secret field whose metadata core's zod can't read is a definition error", () => {
    const input = z.object({
      url: z.string(),
      apiKey: fromForeignZod(z.string().min(3), secretMeta),
    });
    const build = () => nodeWith(input).manifest();
    expect(build).toThrow(FlowlineDefinitionError);
    expect(build).toThrow(/field "apiKey" of the input schema of "host.call"/);
    expect(build).toThrow(/different copy of zod \(4\.1\.0\)/);
    expect(build).toThrow(/pnpm dedupe/);
  });

  test("so is a sensitive or ui() field, nested or wrapped, even from the same zod version", () => {
    const sensitiveField = fromForeignZod(
      z.string(),
      { "x-flowline": { sensitive: true } },
      z.core.version,
    );
    const input = z.object({ person: z.object({ ssn: sensitiveField.optional() }) });
    expect(() => nodeWith(input).manifest()).toThrow(/field "person.ssn"/);

    const labelled = fromForeignZod(z.number(), { "x-flowline": { label: "Count" } });
    expect(() => nodeWith(z.object({ items: z.array(labelled) })).manifest()).toThrow(
      /field "items\[\]"/,
    );
  });

  test("a schema the converter can't read at all is a definition error", () => {
    const unreadable = z.string();
    (unreadable._zod as { version: unknown }).version = { major: 4, minor: 2, patch: 0 };
    // What an incompatible copy's internals amount to: the converter emits nothing for it.
    (unreadable._zod as { processJSONSchema?: () => void }).processJSONSchema = () => {};
    expect(() => nodeWith(z.object({ name: unreadable })).manifest()).toThrow(
      /field "name" of the input schema of "host.call" was built with a different copy of zod \(4\.2\.0\)/,
    );
  });

  // zod 3 (the real one, shipped as "zod/v3"): no `_zod`, no `.meta`.
  test("ui(), secret() and sensitive() on a zod 3 schema say zod ≥4 is required", () => {
    const zod3 = z3.string() as unknown as z.ZodString;
    for (const call of [
      () => ui(zod3, { label: "Name" }),
      () => secret(zod3),
      () => sensitive(zod3),
    ]) {
      expect(call).toThrow(FlowlineDefinitionError);
      expect(call).toThrow(
        /ui\(\) \(or secret\(\)\/sensitive\(\)\) got a zod 3 schema, but flowline requires zod ≥4 \(@flowlinejs\/core uses zod 4\.\d+\.\d+\)/,
      );
      expect(call).toThrow(/upgrade to zod 4/);
      expect(call).toThrow(/pnpm dedupe/);
    }
  });

  test("a zod 3 input schema, or a zod 3 field in a zod 4 object, names what was found", () => {
    const whole = z3.object({ name: z3.string() }) as unknown as z.ZodObject;
    expect(() => nodeWith(whole).manifest()).toThrow(
      /^The input schema of "host\.call" got a zod 3 schema, but flowline requires zod ≥4/,
    );

    const mixed = z.object({
      url: z.string(),
      auth: z.object({ token: z3.string() as unknown as z.ZodString }).optional(),
    });
    expect(() => nodeWith(mixed).manifest()).toThrow(
      /^Field "auth\.token" of the input schema of "host\.call" got a zod 3 schema/,
    );
  });

  test("schemas from core's own zod pass, whatever their shape", () => {
    const input = z.object({
      key: secret(),
      nested: z.object({ tags: z.array(ui(z.string(), { label: "Tag" })).optional() }),
      either: z.union([z.string(), ui(z.number(), { label: "N" })]),
      later: z.lazy(() => ui(z.string(), { label: "Lazy" })),
      piped: ui(z.string(), { label: "Piped" }).transform((s) => s.length),
    });
    expect(() => nodeWith(input).manifest()).not.toThrow();
    expect(nodeWith(input).manifest().nodes[0]?.input.properties).toMatchObject({
      key: { "x-flowline": { secret: true } },
    });
  });
});
