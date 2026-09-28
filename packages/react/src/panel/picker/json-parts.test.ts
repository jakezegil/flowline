import type { ValueExpr } from "@flowlinejs/core";
import { describe, expect, test } from "vitest";
import { jsonToParts, partsToJson } from "./json-parts";

describe("jsonToParts / partsToJson", () => {
  test("refs are pills in value position, templates are strings with pills", () => {
    const value: ValueExpr = {
      to: { $ref: "steps.load.email" },
      greeting: { $tpl: "Hi {{trigger.name}}!" },
      tags: ["a", { $ref: "trigger.tag" }],
      n: 1,
    };
    const parts = jsonToParts(value);
    expect(parts).toEqual([
      { text: '{\n  "to": ' },
      { ref: "steps.load.email" },
      { text: ',\n  "greeting": "Hi ' },
      { ref: "trigger.name" },
      { text: '!",\n  "tags": [\n    "a",\n    ' },
      { ref: "trigger.tag" },
      { text: '\n  ],\n  "n": 1\n}' },
    ]);
    expect(partsToJson(parts)).toEqual({ ok: true, value });
  });

  test("plain JSON round-trips like JSON.stringify(v, null, 2)", () => {
    const value: ValueExpr = { a: [1, true, null], b: {}, c: [], d: 'say "hi"' };
    const parts = jsonToParts(value);
    expect(parts).toEqual([{ text: JSON.stringify(value, null, 2) }]);
    expect(partsToJson(parts)).toEqual({ ok: true, value });
  });

  test("a lone pill is a ref; a quoted pill is a template; literal {{ stays literal", () => {
    expect(partsToJson([{ ref: "trigger.x" }])).toEqual({
      ok: true,
      value: { $ref: "trigger.x" },
    });
    expect(partsToJson([{ text: '["' }, { ref: "trigger.x" }, { text: '"]' }])).toEqual({
      ok: true,
      value: [{ $tpl: "{{trigger.x}}" }],
    });
    expect(partsToJson([{ text: '{"a": "\\"{{ ' }, { ref: "trigger.x" }, { text: '"}' }])).toEqual({
      ok: true,
      value: { a: { $tpl: '"\\{{ {{trigger.x}}' } },
    });
    expect(partsToJson([{ text: '"{{not a pill}}"' }])).toEqual({
      ok: true,
      value: "{{not a pill}}",
    });
  });

  test("typed private-use characters and escapes never read as pills", () => {
    // Raw and escaped U+E000/U+E001, with and without pills around.
    const raw = '{"a": "x0y", "b": "\\ue000\\uE0010\\ue001"}';
    expect(partsToJson([{ text: raw }])).toEqual({
      ok: true,
      value: { a: "x0y", b: "0" },
    });
    expect(
      partsToJson([{ text: '{"a": "0", "b": ' }, { ref: "trigger.x" }, { text: "}" }]),
    ).toEqual({ ok: true, value: { a: "0", b: { $ref: "trigger.x" } } });
  });

  test("a __proto__ key stays an own key", () => {
    const read = partsToJson([{ text: '{"__proto__": ' }, { ref: "trigger.x" }, { text: "}" }]);
    expect(read.ok).toBe(true);
    const value = (read as { value: Record<string, unknown> }).value;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(value, "__proto__")?.value).toEqual({
      $ref: "trigger.x",
    });
  });

  test("a { right before a pill in a string stays literal", () => {
    const parts = [{ text: '{"a": "{' }, { ref: "trigger.x" }, { text: '}"}' }];
    const read = partsToJson(parts);
    expect(read).toEqual({ ok: true, value: { a: { $tpl: "{{{trigger.x}}}" } } });
    const value = (read as { value: ValueExpr }).value;
    expect(jsonToParts(value)).toEqual([
      { text: '{\n  "a": "{' },
      { ref: "trigger.x" },
      { text: '}"\n}' },
    ]);
  });

  test("empty is undefined; invalid JSON and pills in keys are rejected", () => {
    expect(partsToJson([])).toEqual({ ok: true, value: undefined });
    expect(partsToJson([{ text: "  \n" }])).toEqual({ ok: true, value: undefined });
    expect(partsToJson([{ text: "{ nope" }])).toEqual({ ok: false });
    expect(partsToJson([{ text: '{"a": ' }, { ref: "trigger.x" }])).toEqual({ ok: false });
    expect(partsToJson([{ text: '{"' }, { ref: "trigger.x" }, { text: '": 1}' }])).toEqual({
      ok: false,
    });
  });
});
