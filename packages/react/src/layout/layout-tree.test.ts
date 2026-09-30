import {
  type AnnotationColor,
  allStepIds,
  insertStep,
  type Section,
  type Step,
  type WorkflowDoc,
} from "@flowlinejs/core";
import { describe, expect, test } from "vitest";
import { branchyDoc, docWith, fixtureDoc, manifest, step } from "../../test/fixtures";
import {
  BRANCH_GAP,
  CARD_H,
  CARD_W,
  JOIN_SIZE,
  LABEL_H,
  LOOP_GUTTER,
  NOTE_GAP,
  NOTE_W,
  PLACEHOLDER_H,
  SECTION_HEADER_H,
  SECTION_PAD,
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

  test("L12: a branch ending in a Stop doesn't rejoin (no edge, no + after the Stop)", () => {
    const email = manifest.nodes.find((n) => n.type === "crm.sendEmail");
    const stop = { ...(email as NonNullable<typeof email>), type: "logic.stop", endsRun: true };
    const m = { ...manifest, nodes: [...manifest.nodes, stop] };
    const doc = docWith([
      step(
        "cond",
        "logic.condition",
        { value: true },
        {
          branches: { if: [step("email", "crm.sendEmail"), step("stop", "logic.stop")], else: [] },
        },
      ),
    ]);
    const edges = layoutTree(doc, m).edges.map((e) => e.id);
    expect(edges).toContain("step:email->step:stop");
    expect(edges).toContain("ph:cond:else->join:cond");
    expect(edges.some((e) => e.startsWith("step:stop->"))).toBe(false);
    // Disabled, the Stop is skipped at run time, so the branch rejoins.
    const off = docWith([
      step(
        "cond",
        "logic.condition",
        { value: true },
        {
          branches: { if: [step("stop", "logic.stop", {}, { disabled: true })], else: [] },
        },
      ),
    ]);
    expect(layoutTree(off, m).edges.map((e) => e.id)).toContain("step:stop->join:cond");
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

// ---------------------------------------------------------------------------------------------
// Annotations: notes and sections reserve space.

const withSections = (doc: WorkflowDoc, sections: Section[]): WorkflowDoc => ({ ...doc, sections });
const section = (id: string, first: string, last: string, extra: Partial<Section> = {}) =>
  ({ id, title: id, color: "blue", first, last, ...extra }) as Section;
const noted = (id: string, type = "crm.sendEmail") => step(id, type, {}, { note: "Remember" });
const sectionById = (layout: Layout, id: string) => {
  const s = layout.sections.find((r) => r.sectionId === id);
  if (!s) throw new Error(`no region for ${id}`);
  return s;
};
type Rect = { x: number; y: number; w: number; h: number };
const inside = (inner: Rect, outer: Rect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h;
const rectsOverlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const NOTE_R = CARD_W / 2 + NOTE_GAP + NOTE_W;

describe("layoutTree annotations", () => {
  test("a doc without annotations keeps its layout and has no sections or notes", () => {
    for (const doc of [fixtureDoc(), branchyDoc(), docWith([])]) {
      const layout = layoutTree(doc, manifest);
      expect(layout.sections).toEqual([]);
      expect(layout.notes).toEqual([]);
      expect(layoutTree(withSections(doc, []), manifest)).toEqual(layout);
    }
  });

  test("a note on a top-level step widens the root column; the trigger stays centred", () => {
    const layout = layoutTree(docWith([step("a", "crm.sendEmail"), noted("b")]), manifest);
    expect(layout.width).toBe(2 * NOTE_R);
    expect(byId(layout, "trigger").x).toBe(-CARD_W / 2);
    const card = byId(layout, "step:b");
    expect(card.x).toBe(-CARD_W / 2);
    expect(layout.notes).toEqual([
      {
        id: "note:b",
        stepId: "b",
        x: card.x + CARD_W + NOTE_GAP,
        y: card.y,
        w: NOTE_W,
        h: CARD_H,
      },
    ]);
    // Notes are not layout nodes.
    expect(layout.nodes.some((n) => n.id.startsWith("note:"))).toBe(false);
  });

  test("an empty note is no note", () => {
    const layout = layoutTree(docWith([step("a", "crm.sendEmail", {}, { note: "" })]), manifest);
    expect(layout.notes).toEqual([]);
    expect(layout.width).toBe(CARD_W);
  });

  test("a note in the left branch column never covers the right column", () => {
    const doc = docWith([
      step(
        "cond",
        "logic.condition",
        {},
        { branches: { if: [noted("left")], else: [step("right", "crm.sendEmail")] } },
      ),
    ]);
    const layout = layoutTree(doc, manifest);
    const note = layout.notes[0]!;
    expect(note.stepId).toBe("left");
    expect(byId(layout, "step:right").x).toBeGreaterThanOrEqual(note.x + note.w + BRANCH_GAP);
    // The block stays centred on its card; the root spans the whole width.
    expect(byId(layout, "step:cond").x).toBe(-CARD_W / 2);
    expect(layout.width).toBe(2 * CARD_W + NOTE_GAP + NOTE_W + BRANCH_GAP);
    expect(note.x + note.w).toBeLessThanOrEqual(layout.width / 2);
  });

  test("a section around two top-level steps: padding, header band, and pushed-down items", () => {
    const steps = [
      step("a", "crm.sendEmail"),
      step("b", "crm.sendEmail"),
      step("c", "crm.sendEmail"),
      step("d", "crm.sendEmail"),
    ];
    const plain = layoutTree(docWith(steps), manifest);
    const layout = layoutTree(withSections(docWith(steps), [section("grp", "b", "c")]), manifest);
    const b = byId(layout, "step:b");
    const c = byId(layout, "step:c");
    const d = byId(layout, "step:d");
    expect(byId(layout, "step:a")).toEqual(byId(plain, "step:a"));
    expect(b.y).toBe(byId(plain, "step:b").y + SECTION_HEADER_H);
    expect(c.y).toBe(byId(plain, "step:c").y + SECTION_HEADER_H);
    expect(d.y).toBe(byId(plain, "step:d").y + SECTION_HEADER_H + SECTION_PAD);
    expect(layout.sections).toEqual([
      {
        id: "section:grp",
        sectionId: "grp",
        color: "blue",
        x: -CARD_W / 2 - SECTION_PAD,
        y: b.y - SECTION_HEADER_H,
        w: CARD_W + 2 * SECTION_PAD,
        h: c.y + CARD_H + SECTION_PAD - (b.y - SECTION_HEADER_H),
        depth: 0,
      },
    ]);
    expect(inside(b, layout.sections[0]!) && inside(c, layout.sections[0]!)).toBe(true);
    expect(layout.width).toBe(CARD_W + 2 * SECTION_PAD);
    expect(layout.height).toBe(plain.height + SECTION_HEADER_H + SECTION_PAD);
    // Sections are not layout nodes, and node/edge IDs and order are unchanged.
    expect(layout.nodes.map((n) => n.id)).toEqual(plain.nodes.map((n) => n.id));
    expect(layout.edges).toEqual(plain.edges);
  });

  test("a section at the end of a list keeps its bottom padding clear of what follows", () => {
    const steps = [step("a", "crm.sendEmail"), step("b", "crm.sendEmail")];
    const layout = layoutTree(withSections(docWith(steps), [section("s", "a", "b")]), manifest);
    const region = sectionById(layout, "s");
    expect(region.y + region.h + V_GAP).toBe(byId(layout, "end").y);
  });

  test("a section with a note-bearing member widens to cover the note", () => {
    const doc = withSections(docWith([noted("a"), step("b", "crm.sendEmail")]), [
      section("s", "a", "b"),
    ]);
    const layout = layoutTree(doc, manifest);
    const region = sectionById(layout, "s");
    expect(region.x).toBe(-CARD_W / 2 - SECTION_PAD);
    expect(region.x + region.w).toBe(NOTE_R + SECTION_PAD);
    expect(inside(layout.notes[0]!, region)).toBe(true);
    expect(layout.width).toBe(2 * (NOTE_R + SECTION_PAD));
  });

  test("a section inside an else branch stays within the else column", () => {
    const doc = withSections(
      docWith([
        step(
          "cond",
          "logic.condition",
          {},
          {
            branches: {
              if: [step("i1", "crm.sendEmail")],
              else: [step("e1", "crm.sendEmail"), step("e2", "crm.sendEmail")],
            },
          },
        ),
      ]),
      [section("els", "e1", "e2")],
    );
    const layout = layoutTree(doc, manifest);
    const region = sectionById(layout, "els");
    const i1 = byId(layout, "step:i1");
    const e1 = byId(layout, "step:e1");
    expect(region.depth).toBe(1);
    expect(region.x).toBe(e1.x - SECTION_PAD);
    // The else column's extents: its left edge is BRANCH_GAP right of the if column.
    expect(region.x).toBeGreaterThanOrEqual(i1.x + i1.w + BRANCH_GAP);
    expect(region.x + region.w).toBeLessThanOrEqual(layout.width / 2);
    expect(inside(e1, region) && inside(byId(layout, "step:e2"), region)).toBe(true);
    expect(e1.y).toBe(i1.y + SECTION_HEADER_H);
    // The join sits below the section's bottom padding.
    expect(byId(layout, "join:cond").y).toBeGreaterThan(region.y + region.h);
  });

  test("nested sections: an inner region lies inside the outer one, one level deeper", () => {
    const doc = withSections(
      docWith([
        step("a", "crm.sendEmail"),
        step(
          "cond",
          "logic.condition",
          {},
          {
            branches: {
              if: [step("i1", "crm.sendEmail"), step("i2", "crm.sendEmail")],
              else: [],
            },
          },
        ),
      ]),
      [section("inner", "i1", "i2"), section("outer", "a", "cond")],
    );
    const layout = layoutTree(doc, manifest);
    const inner = sectionById(layout, "inner");
    const outer = sectionById(layout, "outer");
    expect(inside(inner, outer)).toBe(true);
    expect(inner.depth).toBeGreaterThan(outer.depth);
    // Regions come in doc order.
    expect(layout.sections.map((s) => s.id)).toEqual(["section:inner", "section:outer"]);
  });

  test("a section whose last member is a block ends below the block's join", () => {
    const doc = withSections(
      docWith([
        step(
          "cond",
          "logic.condition",
          {},
          { branches: { if: [step("i1", "crm.sendEmail")], else: [] } },
        ),
        step("after", "crm.sendEmail"),
      ]),
      [section("s", "cond", "cond")],
    );
    const layout = layoutTree(doc, manifest);
    const region = sectionById(layout, "s");
    const join = byId(layout, "join:cond");
    expect(region.y + region.h).toBe(join.y + join.h + SECTION_PAD);
    expect(byId(layout, "step:after").y).toBe(join.y + join.h + SECTION_PAD + V_GAP);
  });

  test("broken sections reserve nothing; unknown colours draw gray", () => {
    const steps = [
      step("a", "crm.sendEmail"),
      step("cond", "logic.condition", {}, { branches: { if: [step("i", "crm.sendEmail")] } }),
      step("b", "crm.sendEmail"),
    ];
    const plain = layoutTree(docWith(steps), manifest);
    const broken = withSections(docWith(steps), [
      section("missing", "nope", "b"),
      section("reversed", "b", "a"),
      section("two-lists", "a", "i"),
    ]);
    let layout: Layout | undefined;
    expect(() => {
      layout = layoutTree(broken, manifest);
    }).not.toThrow();
    expect(layout).toEqual(plain);

    const red = withSections(docWith(steps), [
      section("r", "a", "a", { color: "red" as AnnotationColor }),
    ]);
    expect(layoutTree(red, manifest).sections.map((s) => s.color)).toEqual(["gray"]);
  });

  test("a section whose parent ID is duplicated is dropped, not drawn on the wrong list", () => {
    // Two steps share the ID "cond". The run resolves inside the second one's
    // branch, but looking the parent up again finds the first, whose list
    // doesn't hold the run at those indices.
    const doc = withSections(
      docWith([
        step("cond", "logic.condition", {}, { branches: { if: [step("x", "crm.sendEmail")] } }),
        step("cond", "logic.condition", {}, { branches: { if: [step("i", "crm.sendEmail")] } }),
      ]),
      [section("dup-parent", "i", "i")],
    );
    let layout: Layout | undefined;
    expect(() => {
      layout = layoutTree(doc, manifest);
    }).not.toThrow();
    expect(layout!.sections).toEqual([]);
  });

  test("a 5000-char note and overlapping or duplicate sections lay out without throwing", () => {
    const doc = withSections(
      docWith([
        step("a", "crm.sendEmail", {}, { note: "x".repeat(5000) }),
        step("b", "crm.sendEmail"),
        step("c", "crm.sendEmail"),
      ]),
      [section("s1", "a", "b"), section("s2", "b", "c"), section("s2", "c", "c")],
    );
    const layout = layoutTree(doc, manifest);
    expect(layout.notes).toHaveLength(1);
    expect(layout.notes[0]!.h).toBe(CARD_H);
    expect(layout.sections.map((s) => s.sectionId)).toEqual(["s1", "s2", "s2"]);
    // Region IDs stay unique even when section IDs repeat.
    expect(new Set(layout.sections.map((s) => s.id)).size).toBe(3);
    expect(layout.sections[1]!.id).toBe("section:s2");
  });

  test("is deterministic on an annotated doc", () => {
    const layout = layoutTree(annotatedDoc(), manifest);
    expect(layoutTree(annotatedDoc(), manifest)).toEqual(layout);
    expect(layout.sections).toHaveLength(3);
    expect(layout.notes).toHaveLength(3);
  });
});

/** Sections at the top level and in a branch, notes, and a loop whose body holds a section. */
function annotatedDoc(): WorkflowDoc {
  return withSections(
    docWith([
      noted("load", "crm.loadContact"),
      step(
        "cond",
        "logic.condition",
        {},
        {
          branches: {
            if: [noted("i1"), step("i2", "crm.sendEmail")],
            else: [step("e1", "crm.sendEmail")],
          },
        },
      ),
      step(
        "each",
        "logic.forEach",
        {},
        { branches: { body: [step("b1", "crm.sendEmail"), noted("b2")] } },
      ),
    ]),
    [
      section("top", "load", "cond", { color: "yellow" }),
      section("ifs", "i1", "i2", { color: "green" }),
      section("body", "b1", "b2", { color: "purple" }),
    ],
  );
}

/** A random tree with notes on some steps and sections over some runs of each list. */
function randomAnnotatedDoc(seed: number): WorkflowDoc {
  const doc = randomDoc(seed);
  const r = rng(seed * 7919);
  const sections: Section[] = [];
  const annotate = (list: Step[]) => {
    for (const s of list) {
      if (r() < 0.3) s.note = "A note";
      for (const kids of Object.values(s.branches ?? {})) annotate(kids);
    }
    let i = 0;
    while (i < list.length) {
      if (r() < 0.4) {
        const end = Math.min(list.length - 1, i + Math.floor(r() * 3));
        sections.push(section(`sec${sections.length}`, list[i]!.id, list[end]!.id));
        i = end + 1;
      } else {
        i++;
      }
    }
  };
  annotate(doc.steps);
  return withSections(doc, sections);
}

describe("layoutTree annotation invariants (200 random annotated trees)", () => {
  const cases = Array.from({ length: 200 }, (_, i) => i + 1);

  test.each(cases)("seed %i", (seed) => {
    const doc = randomAnnotatedDoc(seed);
    const layout = layoutTree(doc, manifest);
    const cards = new Map(layout.nodes.map((n) => [n.id, n]));
    const withinWidth = (rect: Rect) =>
      rect.x >= -layout.width / 2 && rect.x + rect.w <= layout.width / 2;

    expect(layout.sections).toHaveLength(doc.sections!.length);
    for (const note of layout.notes) {
      expect(withinWidth(note)).toBe(true);
      for (const n of layout.nodes) {
        if (rectsOverlap(note, n)) throw new Error(`seed ${seed}: ${note.id} overlaps ${n.id}`);
      }
      for (const other of layout.notes) {
        if (other !== note && rectsOverlap(note, other)) {
          throw new Error(`seed ${seed}: ${note.id} overlaps ${other.id}`);
        }
      }
    }
    for (const region of layout.sections) {
      expect(withinWidth(region)).toBe(true);
      expect(region.y + region.h).toBeLessThanOrEqual(layout.height);
      const s = doc.sections!.find((x) => `section:${x.id}` === region.id)!;
      for (const id of [s.first, s.last]) {
        expect(inside(cards.get(`step:${id}`)!, region)).toBe(true);
        const note = layout.notes.find((nt) => nt.stepId === id);
        if (note) expect(inside(note, region)).toBe(true);
      }
      // Nothing outside the section's list pokes into it at its own depth or shallower.
      for (const other of layout.sections) {
        if (other === region || other.depth !== region.depth) continue;
        expect(rectsOverlap(region, other)).toBe(false);
      }
    }
  });
});
