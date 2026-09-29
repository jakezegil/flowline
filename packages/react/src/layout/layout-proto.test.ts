import { describe, expect, test } from "vitest";
import { docWith, manifest, step } from "../../test/fixtures";
import { layoutTree } from "./layout-tree";

describe("layoutTree: prototype-safe branch access", () => {
  test("a declared branch named like an Object.prototype key, missing from the step, lays out empty", () => {
    const sw = step(
      "sw",
      "logic.switch",
      {
        value: "x",
        cases: [
          { id: "constructor", label: "Ctor" },
          { id: "toString", label: "Str" },
        ],
      },
      { branches: { default: [] } },
    );
    const layout = layoutTree(docWith([sw]), manifest);
    expect(layout.nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining(["ph:sw:constructor", "ph:sw:toString", "ph:sw:default"]),
    );
  });
});
