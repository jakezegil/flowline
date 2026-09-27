import { allStepIds, insertStep, type Step, type WorkflowDoc } from "@flowkit/core";
import { describe, expect, test } from "vitest";
import { branchyDoc, docWith, fixtureDoc, manifest, step } from "../../test/fixtures";
import {
  BRANCH_GAP,
  CARD_H,
  CARD_W,
  JOIN_SIZE,
  LABEL_H,
  LOOP_GUTTER,
  PLACEHOLDER_H,
  V_GAP,
} from "./constants";
import { type LayoutNode, layoutTree } from "./layout-tree";

type Layout = ReturnType<typeof layoutTree>;

/** Compact, readable form of a layout for snapshots. */
function compact(layout: Layout) {
  return {
    size: [layout.width, layout.height],
    nodes: layout.nodes.map((n) => `${n.id} ${n.kind} @${n.x},${n.y} ${n.w}x${n.h}`),
    edges: layout.edges.map((e) => {
      const loc =
        "loc" in e && e.loc
          ? ` [${e.loc.parentId ?? "root"}/${e.loc.branch ?? ""}#${e.loc.index}]`
          : "";
      const label = e.kind === "branch" ? ` "${e.label}"` : "";
      return `${e.kind} ${e.source} -> ${e.target}${label}${loc}`;
    }),
  };
}

const byId = (layout: Layout, id: string) => layout.nodes.find((n) => n.id === id)!;
const stepNode = (layout: Layout, id: string) => {
  const n = byId(layout, `step:${id}`);
  if (n.kind !== "step") throw new Error(`${id} is not a step node`);
  return n;
};

describe("layoutTree", () => {
  test("linear: a centered column with + edges between every pair", () => {
    const layout = layoutTree(fixtureDoc(), manifest);
    const half = CARD_W / 2;
    expect(byId(layout, "trigger")).toMatchObject({ x: -half, y: 0, w: CARD_W, h: CARD_H });
    expect(byId(layout, "step:load")).toMatchObject({ x: -half, y: CARD_H + V_GAP, depth: 0 });
    expect(byId(layout, "step:email")).toMatchObject({ y: 2 * (CARD_H + V_GAP) });
    expect(byId(layout, "end")).toMatchObject({
      x: -JOIN_SIZE / 2,
      y: 3 * (CARD_H + V_GAP),
      w: JOIN_SIZE,
    });
    expect(layout.width).toBe(CARD_W);
    expect(layout.height).toBe(3 * (CARD_H + V_GAP) + JOIN_SIZE);
    expect(compact(layout)).toMatchSnapshot();
  });

  test("empty workflow: trigger → end with one insertion point", () => {
    const layout = layoutTree(docWith([]), manifest);
    expect(layout.nodes.map((n) => n.id)).toEqual(["trigger", "end"]);
    expect(layout.edges).toEqual([
      {
        id: "trigger->end",
        kind: "add",
        source: "trigger",
        target: "end",
        loc: { parentId: null, index: 0 },
      },
    ]);
  });

  test("condition with an empty else: columns centered under the card, placeholder, join", () => {
    const doc = docWith([
      step(
        "cond",
        "logic.condition",
        { value: true },
        { branches: { if: [step("email", "crm.sendEmail")], else: [] } },
      ),
      step("after", "crm.sendEmail"),
    ]);
    const layout = layoutTree(doc, manifest);
    const cond = byId(layout, "step:cond");
    const email = byId(layout, "step:email");
    const ph = byId(layout, "ph:cond:else");
    const join = byId(layout, "join:cond");
    const branchTop = cond.y + CARD_H + V_GAP + LABEL_H;
    expect(cond.x).toBe(-CARD_W / 2);
    expect(email).toMatchObject({ x: -CARD_W - BRANCH_GAP / 2, y: branchTop, depth: 1 });
    expect(ph).toMatchObject({ x: BRANCH_GAP / 2, y: branchTop, w: CARD_W, h: PLACEHOLDER_H });
    expect(join).toMatchObject({ x: -JOIN_SIZE / 2, y: branchTop + CARD_H + V_GAP });
    expect(byId(layout, "step:after").y).toBe(join.y + JOIN_SIZE + V_GAP);
    expect(layout.width).toBe(2 * CARD_W + BRANCH_GAP);
    expect(layout.edges).toContainEqual({
      id: "step:cond->ph:cond:else",
      kind: "branch",
      source: "step:cond",
      target: "ph:cond:else",
      label: "Else",
      branchId: "else",
      loc: { parentId: "cond", branch: "else", index: 0 },
    });
    expect(layout.edges).toContainEqual({
      id: "ph:cond:else->join:cond",
      kind: "join",
      source: "ph:cond:else",
      target: "join:cond",
    });
    expect(layout.edges).toContainEqual({
      id: "step:email->join:cond",
      kind: "join",
      source: "step:email",
      target: "join:cond",
      loc: { parentId: "cond", branch: "if", index: 1 },
    });
    expect(compact(layout)).toMatchSnapshot();
  });

  test("nested switch in a loop: body column with gutter and a loop-return edge", () => {
    const doc = docWith([
      step(
        "each",
        "logic.forEach",
        { items: { $ref: "trigger.contactId" } },
        {
          branches: {
            body: [
              step(
                "sw",
                "logic.switch",
                {
                  value: "x",
                  cases: [
                    { id: "a", label: "A" },
                    { id: "b", label: "B" },
                  ],
                },
                {
                  branches: {
                    a: [step("m1", "crm.sendEmail"), step("m2", "crm.sendEmail")],
                    b: [],
                    default: [],
                  },
                },
              ),
            ],
          },
        },
      ),
    ]);
    const layout = layoutTree(doc, manifest);
    const each = byId(layout, "step:each");
    const sw = stepNode(layout, "sw");
    expect(sw.y).toBe(each.y + CARD_H + V_GAP + LABEL_H);
    expect(sw.depth).toBe(1);
    expect(stepNode(layout, "m1").depth).toBe(2);
    // Three branch columns + the loop gutters on both sides.
    expect(layout.width).toBe(3 * CARD_W + 2 * BRANCH_GAP + 2 * LOOP_GUTTER);
    expect(layout.edges).toContainEqual({
      id: "join:each->step:each",
      kind: "loopReturn",
      source: "join:each",
      target: "step:each",
    });
    expect(layout.edges).toContainEqual(
      expect.objectContaining({
        kind: "branch",
        source: "step:each",
        target: "step:sw",
        label: "Body",
      }),
    );
    expect(compact(layout)).toMatchSnapshot();
  });

  test("steps of unknown types and undeclared branches are still laid out", () => {
    const doc = docWith([
      step("u", "gone.node", {}, { branches: { x: [step("inner", "crm.sendEmail")] } }),
      step(
        "c",
        "logic.condition",
        {},
        { branches: { if: [], else: [], stale: [step("old", "crm.sendEmail")] } },
      ),
    ]);
    const layout = layoutTree(doc, manifest);
    expect(layout.nodes.filter((n) => n.kind === "step").map((n) => n.id)).toEqual([
      "step:u",
      "step:inner",
      "step:c",
      "step:old",
    ]);
    expect(layout.edges).toContainEqual(
      expect.objectContaining({ kind: "branch", target: "step:old", label: "stale" }),
    );
  });

  test("is deterministic", () => {
    expect(layoutTree(branchyDoc(), manifest)).toEqual(layoutTree(branchyDoc(), manifest));
  });
});

// ---------------------------------------------------------------------------------------------
// Property-style invariants over random trees.

/** Small seeded PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDoc(seed: number): WorkflowDoc {
  const r = rng(seed);
  const int = (n: number) => Math.floor(r() * n);
  let next = 0;
  const makeList = (depth: number): Step[] => {
    const list: Step[] = [];
    const len = int(depth === 0 ? 5 : 4);
    for (let i = 0; i < len; i++) {
      const id = `s${next++}`;
      const kind = depth >= 3 ? 0 : int(5);
      if (kind === 1) {
        list.push(
          step(
            id,
            "logic.condition",
            {},
            { branches: { if: makeList(depth + 1), else: makeList(depth + 1) } },
          ),
        );
      } else if (kind === 2) {
        const cases = Array.from({ length: int(3) }, (_, k) => ({
          id: `c${k}`,
          label: `Case ${k}`,
        }));
        const branches: Record<string, Step[]> = { default: makeList(depth + 1) };
        for (const c of cases) branches[c.id] = makeList(depth + 1);
        list.push(step(id, "logic.switch", { cases }, { branches }));
      } else if (kind === 3) {
        list.push(step(id, "logic.forEach", {}, { branches: { body: makeList(depth + 1) } }));
      } else {
        list.push(step(id, int(2) ? "crm.sendEmail" : "crm.loadContact"));
      }
    }
    return list;
  };
  return docWith(makeList(0));
}

function overlaps(a: LayoutNode, b: LayoutNode): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

type Span = { left: number; right: number };
const union = (spans: Span[]): Span => ({
  left: Math.min(...spans.map((s) => s.left)),
  right: Math.max(...spans.map((s) => s.right)),
});
const spanOf = (n: LayoutNode): Span => ({ left: n.x, right: n.x + n.w });

/**
 * Horizontal extent of `s`'s block (card, branch columns, loop gutters), asserting on the way that
 * each block's branch columns and join are centered under its card and sit below it.
 */
function blockExtent(layout: Layout, s: Step): Span {
  const card = byId(layout, `step:${s.id}`);
  const branches = Object.entries(s.branches ?? {});
  if (branches.length === 0) return spanOf(card);
  const center = card.x + card.w / 2;
  const cols = branches.map(([branch, list]) => {
    const head =
      list.length === 0
        ? byId(layout, `ph:${s.id}:${branch}`)
        : byId(layout, `step:${list[0]!.id}`);
    expect(head.y).toBeGreaterThan(card.y + card.h);
    return list.length === 0 ? spanOf(head) : union(list.map((c) => blockExtent(layout, c)));
  });
  let kids = union(cols);
  expect(kids.left + kids.right).toBe(2 * center);
  const join = byId(layout, `join:${s.id}`);
  expect(join.x + join.w / 2).toBe(center);
  if (s.type === "logic.forEach") {
    kids = { left: kids.left - LOOP_GUTTER, right: kids.right + LOOP_GUTTER };
  }
  return union([spanOf(card), kids]);
}

describe("layoutTree invariants (200 random trees)", () => {
  const cases = Array.from({ length: 200 }, (_, i) => i + 1);

  test.each(cases)("seed %i", (seed) => {
    const doc = randomDoc(seed);
    const layout = layoutTree(doc, manifest);
    const { nodes, edges } = layout;

    // Unique ids; edges connect existing nodes.
    const nodeIds = new Set(nodes.map((n) => n.id));
    expect(nodeIds.size).toBe(nodes.length);
    expect(new Set(edges.map((e) => e.id)).size).toBe(edges.length);
    for (const e of edges) {
      expect(nodeIds.has(e.source) && nodeIds.has(e.target)).toBe(true);
    }

    // No two nodes overlap.
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        if (overlaps(a, b)) throw new Error(`seed ${seed}: ${a.id} overlaps ${b.id}`);
      }
    }

    // Every step is present exactly once.
    const stepIds = nodes.flatMap((n) => (n.kind === "step" ? [n.stepId] : []));
    expect(stepIds.sort()).toEqual([...allStepIds(doc)].sort());

    // Every insertion point is a valid insertStep location.
    for (const e of edges) {
      if (!("loc" in e) || !e.loc) continue;
      expect(() => insertStep(doc, e.loc!, step("zzNew", "crm.sendEmail"))).not.toThrow();
    }
    for (const n of nodes) {
      if (n.kind === "placeholder") {
        expect(() => insertStep(doc, n.loc, step("zzNew", "crm.sendEmail"))).not.toThrow();
      }
    }

    // Bounds cover every node.
    const minX = Math.min(...nodes.map((n) => n.x));
    const maxX = Math.max(...nodes.map((n) => n.x + n.w));
    const maxY = Math.max(...nodes.map((n) => n.y + n.h));
    expect(minX).toBeGreaterThanOrEqual(-layout.width / 2);
    expect(maxX).toBeLessThanOrEqual(layout.width / 2);
    expect(layout.height).toBe(maxY);
    expect(byId(layout, "trigger").x).toBe(-CARD_W / 2); // root column centered at x = 0

    // Blocks are centered over their children, and the root column spans exactly `width`.
    const root = union([
      spanOf(byId(layout, "trigger")),
      ...doc.steps.map((s) => blockExtent(layout, s)),
    ]);
    expect(root).toEqual({ left: -layout.width / 2, right: layout.width / 2 });
  });
});
