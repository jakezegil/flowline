import { describe, expect, test } from "vitest";
import { resolveStepRef, resolveValuePlaceholders } from "./placeholders";

const ids = new Map([
  ["$1", "getDeal"],
  ["$deal", "loadDeal"],
]);

describe("resolveStepRef", () => {
  test("placeholders resolve; real IDs pass through; unknown placeholders are undefined", () => {
    expect(resolveStepRef("$1", ids)).toBe("getDeal");
    expect(resolveStepRef("$deal", ids)).toBe("loadDeal");
    expect(resolveStepRef("wait", ids)).toBe("wait");
    expect(resolveStepRef("$9", ids)).toBeUndefined();
  });
});

describe("resolveValuePlaceholders", () => {
  test("rewrites $ref heads and every template ref, keeping the rest of the text", () => {
    const used = new Map<string, string>();
    const r = resolveValuePlaceholders(
      {
        a: { $ref: "steps.$1.deal.id" },
        b: [{ $tpl: "Hi {{ steps.$deal.name }} and {{steps.$1.x}} / {{ trigger.a }}" }],
        c: "steps.$1 in plain text stays",
        d: { $ref: "trigger.deal.id" },
      },
      ids,
      used,
    );
    expect(r).toEqual({
      value: {
        a: { $ref: "steps.getDeal.deal.id" },
        b: [{ $tpl: "Hi {{ steps.loadDeal.name }} and {{steps.getDeal.x}} / {{ trigger.a }}" }],
        c: "steps.$1 in plain text stays",
        d: { $ref: "trigger.deal.id" },
      },
    });
    expect(Object.fromEntries(used)).toEqual({ $1: "getDeal", $deal: "loadDeal" });
  });

  test("returns the value itself when nothing changes", () => {
    const v = { a: [{ $ref: "steps.real.x" }, { $tpl: "{{ steps.real.y }}" }], b: 1 };
    expect(resolveValuePlaceholders(v, ids).value).toBe(v);
  });

  test("reports the first unknown placeholder", () => {
    const r = resolveValuePlaceholders({ $tpl: "{{ steps.$2.a }} {{ steps.$3.b }}" }, ids);
    expect(r.unknown).toBe("$2");
    expect(resolveValuePlaceholders({ $ref: "steps.$x.a" }, ids).unknown).toBe("$x");
  });
});
