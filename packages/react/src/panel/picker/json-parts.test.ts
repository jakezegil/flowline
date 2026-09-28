import type { ValueExpr } from "@flowkit/core";
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
