import type { Section, Step, WorkflowDoc } from "@flowlinejs/core";
import { describe, expect, test } from "vitest";
import { branchyDoc, docWith, manifest, step } from "../../test/fixtures";
import { LOOP_GUTTER } from "../layout/constants";
import { layoutTree } from "../layout/layout-tree";
import { edgeGeometries } from "./geometry";

/** The x of the vertical leg of a `loopReturn` path (its first `Q` control point). */
function returnX(path: string): number {
  const m = /Q (-?[\d.]+) /.exec(path);
  if (!m) throw new Error(`no Q in ${path}`);
  return Number(m[1]);
}

const loopDoc = (body: Step[], sections: Section[] = []): WorkflowDoc => ({
  ...docWith([
    step("a", "crm.sendEmail"),
    step("each", "logic.forEach", {}, { branches: { body } }),
  ]),
  sections,
});

const body = () => [step("b1", "crm.sendEmail"), step("b2", "crm.sendEmail")];
const sec: Section = { id: "s", title: "S", color: "green", first: "b1", last: "b2" };

describe("edgeGeometries", () => {
  test("without obstacles the output is unchanged", () => {
    for (const doc of [branchyDoc(), loopDoc(body()), loopDoc(body(), [sec])]) {
      const { nodes, edges } = layoutTree(doc, manifest);
      const plain = edgeGeometries(nodes, edges, LOOP_GUTTER);
      expect(edgeGeometries(nodes, edges, LOOP_GUTTER, [])).toEqual(plain);
    }
  });

  test("a loop whose body holds a section returns left of the section region", () => {
    const layout = layoutTree(loopDoc(body(), [sec]), manifest);
    const region = layout.sections[0]!;
    const geo = edgeGeometries(layout.nodes, layout.edges, LOOP_GUTTER, layout.sections);
    const x = returnX(geo.get("join:each->step:each")!.path);
    expect(x).toBeLessThan(region.x);
    // It stays inside the loop's gutter: right of the loop block's left extent.
    expect(x).toBeGreaterThanOrEqual(-layout.width / 2);
    // Without the obstacle, the route hugs the body cards and cuts through the region.
    const bare = edgeGeometries(layout.nodes, layout.edges, LOOP_GUTTER);
    expect(returnX(bare.get("join:each->step:each")!.path)).toBeGreaterThan(region.x);
  });

  test("obstacles outside the loop don't move its return route", () => {
    const layout = layoutTree(loopDoc(body()), manifest);
    const bare = edgeGeometries(layout.nodes, layout.edges, LOOP_GUTTER);
    const card = layout.nodes.find((n) => n.id === "step:a")!;
    // Above the loop, far left.
    const above = { x: -2000, y: card.y, w: 100, h: card.h };
    // Level with the loop body, but in another column to the left.
    const b1 = layout.nodes.find((n) => n.id === "step:b1")!;
    const beside = { x: -2000, y: b1.y, w: 100, h: b1.h };
    expect(edgeGeometries(layout.nodes, layout.edges, LOOP_GUTTER, [above, beside])).toEqual(bare);
  });
});
