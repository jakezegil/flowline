import {
  type AnnotationColor,
  branchesFor,
  findStep,
  isAnnotationColor,
  type Manifest,
  type NodeManifest,
  type Section,
  type Step,
  type StepLocation,
  sectionRun,
  type WorkflowDoc,
} from "@flowlinejs/core";
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

/**
 * A positioned node of the canvas. `x`/`y` are the node's top-left corner in canvas pixels; the
 * root column is centered on `x = 0` and the trigger sits at `y = 0`.
 *
 * Node IDs: `trigger`, `step:<stepId>`, `ph:<parentId>:<branch>` (empty-branch placeholder),
 * `join:<blockId>` (where a block's branches rejoin) and `end`.
 */
export type LayoutNode =
  | { id: string; kind: "trigger"; x: number; y: number; w: number; h: number }
  | {
      id: string;
      kind: "step";
      /** The step's ID in the doc. */
      stepId: string;
      x: number;
      y: number;
      w: number;
      h: number;
      /** Nesting depth: 0 for top-level steps, +1 per enclosing block. */
      depth: number;
    }
  | {
      id: string;
      kind: "placeholder";
      /** Where a step picked from this placeholder is inserted (index 0 of the empty branch). */
      loc: StepLocation;
      x: number;
      y: number;
      w: number;
      h: number;
    }
  | {
      id: string;
      kind: "join";
      /** The branching or looping step whose branches rejoin here. */
      blockId: string;
      x: number;
      y: number;
      w: number;
      h: number;
    }
  | { id: string; kind: "end"; x: number; y: number; w: number; h: number };

/**
 * A connection between two {@link LayoutNode}s. Edge IDs are `<source>-><target>`.
 *
 * - `add`: between consecutive nodes of a column; its "+" inserts at `loc`.
 * - `branch`: from a block's card to the first node of one branch column, labelled; "+" inserts at
 *   the top of that branch.
 * - `join`: from the last node of a branch column into the block's join node; `loc` appends to the
 *   branch, and is absent when the branch is empty (its placeholder is the insertion point). A
 *   branch ending in a step that ends the run (a Stop) has none.
 * - `loopReturn`: from a loop's join node back up to the loop card's side (routed through the
 *   {@link LOOP_GUTTER}).
 */
export type LayoutEdge =
  | { id: string; kind: "add"; source: string; target: string; loc: StepLocation }
  | {
      id: string;
      kind: "branch";
      source: string;
      target: string;
      /** Branch label, e.g. `"Else"`. */
      label: string;
      /** Branch key in the parent's `branches`. */
      branchId: string;
      loc: StepLocation;
    }
  | { id: string; kind: "join"; source: string; target: string; loc?: StepLocation }
  | { id: string; kind: "loopReturn"; source: string; target: string };

/**
 * The region drawn behind a section's member cards, in canvas pixels. The layout reserves it: the
 * members' column is widened by {@link SECTION_PAD} on each side, the first member is pushed down
 * by {@link SECTION_HEADER_H} for the header band, and whatever follows the last member is pushed
 * down by {@link SECTION_PAD}. A broken section (one without a valid run) gets no region.
 */
export interface LayoutSection {
  /**
   * `section:<id>`. Unique within the layout: when a hand-edited doc repeats a section ID, each
   * later region gets `section:<id>~<index in doc.sections>`.
   */
  id: string;
  /** The section's ID in the doc. */
  sectionId: string;
  /** The section's colour, or `"gray"` when the doc holds a colour outside the palette. */
  color: AnnotationColor;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Depth of the section's step list (0 for the top level), for the z-order of nested regions. */
  depth: number;
}

/**
 * A sticky note pinned to the right of its step card, in canvas pixels. The layout reserves its
 * width ({@link NOTE_GAP} + {@link NOTE_W}), so a note never covers a neighbouring column.
 */
export interface LayoutNote {
  /** `note:<stepId>`. */
  id: string;
  /** The step the note belongs to. */
  stepId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A {@link LayoutEdge} before its ID is derived. */
type EdgeInput = LayoutEdge extends infer E
  ? E extends LayoutEdge
    ? Omit<E, "id">
    : never
  : never;

/** Horizontal extents left (`l`) and right (`r`) of a column's centre line, plus the height. */
interface Extent {
  l: number;
  r: number;
  h: number;
}

interface Column {
  id: string;
  label: string;
  steps: Step[];
}

/** A valid section run within one step list. */
interface ListSection {
  /** Index in `doc.sections`. */
  order: number;
  /** Layout ID of the region. */
  id: string;
  section: Section;
  start: number;
  end: number;
}

/** The space the sections of one step list reserve, by item index. */
interface ListMarks {
  /** Header bands above item `i`: one per section starting there. */
  headers: number[];
  /** Bottom paddings below item `i`: one per section ending there. */
  pads: number[];
  /** Whether item `i` is a member of any section of this list. */
  inside: boolean[];
  sections: ListSection[];
}

const HALF = CARD_W / 2;

const manifestIndexes = new WeakMap<Manifest, Map<string, NodeManifest>>();

function nodeIndex(manifest: Manifest): Map<string, NodeManifest> {
  let idx = manifestIndexes.get(manifest);
  if (!idx) {
    idx = new Map(manifest.nodes.map((n) => [n.type, n]));
    manifestIndexes.set(manifest, idx);
  }
  return idx;
}

/**
 * Computes a deterministic, top-down tree layout of a workflow: fixed-size cards stacked in
 * columns, branch columns laid out left to right (in the node's declared branch order) and
 * centered under their block's card, each branch rejoining at a `join` node before the column
 * continues. Loops lay their body out as a single column with a `loopReturn` edge.
 *
 * Every step appears exactly once, including steps of unknown node types and steps in branches
 * the node no longer declares (appended after the declared ones, labelled by key), so nothing in
 * the doc is ever hidden. Pure: the same doc and manifest always produce the same positions.
 *
 * Annotations reserve space. A step's note widens its column on the right, and a section pads its
 * members' column and adds a header band above them (see {@link LayoutSection}). Notes and
 * sections come back in their own arrays, never in `nodes`, so a doc without annotations lays out
 * exactly as before.
 *
 * @returns Nodes (pre-order), edges, section regions (in `doc.sections` order), notes
 *   (pre-order), and the overall `width` (centered on `x = 0`) and `height`.
 */
export function layoutTree(
  doc: WorkflowDoc,
  manifest: Manifest,
): {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  sections: LayoutSection[];
  notes: LayoutNote[];
  width: number;
  height: number;
} {
  const idx = nodeIndex(manifest);
  const nodes: LayoutNode[] = [];
  const edges: LayoutEdge[] = [];
  const notes: LayoutNote[] = [];
  const regions: (LayoutSection | undefined)[] = [];
  const sizes = new Map<Step, Extent>();
  const columnCache = new Map<Step, Column[]>();
  const marks = sectionMarks(doc);

  function columnsOf(step: Step): Column[] {
    const cached = columnCache.get(step);
    if (cached) return cached;
    const m = idx.get(step.type);
    const declared = m ? branchesFor(m, step) : [];
    const cols: Column[] = [];
    const seen = new Set<string>();
    for (const b of declared) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      cols.push({ id: b.id, label: b.label, steps: step.branches?.[b.id] ?? [] });
    }
    for (const [key, list] of Object.entries(step.branches ?? {})) {
      if (seen.has(key)) continue;
      // Undeclared branches are only shown when they still hold steps.
      if (m && list.length === 0) continue;
      seen.add(key);
      cols.push({ id: key, label: key, steps: list });
    }
    columnCache.set(step, cols);
    return cols;
  }

  const isLoop = (step: Step) => idx.get(step.type)?.branches.kind === "loop";

  function measureColumn(steps: Step[]): Extent {
    if (steps.length === 0) return { l: HALF, r: HALF, h: PLACEHOLDER_H };
    const m = marks.get(steps);
    let l = 0;
    let r = 0;
    let h = 0;
    steps.forEach((s, i) => {
      const size = measureItem(s);
      const pad = m?.inside[i] ? SECTION_PAD : 0;
      l = Math.max(l, size.l + pad);
      r = Math.max(r, size.r + pad);
      h += size.h;
      if (m) h += (m.headers[i] as number) * SECTION_HEADER_H + (m.pads[i] as number) * SECTION_PAD;
    });
    return { l, r, h: h + V_GAP * (steps.length - 1) };
  }

  /** The combined width of branch columns laid side by side. */
  const innerSpan = (colSizes: Extent[]) =>
    colSizes.reduce((sum, c) => sum + c.l + c.r, 0) + BRANCH_GAP * (colSizes.length - 1);

  function measureItem(step: Step): Extent {
    const cached = sizes.get(step);
    if (cached) return cached;
    const cols = columnsOf(step);
    const cardR = hasNote(step) ? HALF + NOTE_GAP + NOTE_W : HALF;
    let size: Extent;
    if (cols.length === 0) {
      size = { l: HALF, r: cardR, h: CARD_H };
    } else {
      const colSizes = cols.map((c) => measureColumn(c.steps));
      const half = innerSpan(colSizes) / 2 + (isLoop(step) ? LOOP_GUTTER : 0);
      const colsH = Math.max(...colSizes.map((c) => c.h));
      size = {
        l: Math.max(HALF, half),
        r: Math.max(cardR, half),
        h: CARD_H + V_GAP + LABEL_H + colsH + V_GAP + JOIN_SIZE,
      };
    }
    sizes.set(step, size);
    return size;
  }

  const edge = (e: EdgeInput) => {
    edges.push({ id: `${e.source}->${e.target}`, ...e } as LayoutEdge);
  };

  /**
   * Places `step` (and its subtree) with its card centered on `cx` and its top at `top`.
   * @returns The ID of the node the column continues from (the card, or the block's join).
   */
  function placeItem(step: Step, cx: number, top: number, depth: number): string {
    const cardId = `step:${step.id}`;
    nodes.push({
      id: cardId,
      kind: "step",
      stepId: step.id,
      x: cx - CARD_W / 2,
      y: top,
      w: CARD_W,
      h: CARD_H,
      depth,
    });
    if (hasNote(step)) {
      notes.push({
        id: `note:${step.id}`,
        stepId: step.id,
        x: cx - CARD_W / 2 + CARD_W + NOTE_GAP,
        y: top,
        w: NOTE_W,
        h: CARD_H,
      });
    }
    const cols = columnsOf(step);
    if (cols.length === 0) return cardId;

    const colSizes = cols.map((c) => measureColumn(c.steps));
    const inner = innerSpan(colSizes);
    const branchTop = top + CARD_H + V_GAP + LABEL_H;
    const joinId = `join:${step.id}`;
    const exits: { col: Column; lastId: string }[] = [];
    let left = cx - inner / 2;
    cols.forEach((col, i) => {
      const { l, r } = colSizes[i] as Extent;
      const lastId = placeColumn(col, step.id, left + l, branchTop, depth + 1, (target) => ({
        kind: "branch",
        source: cardId,
        target,
        label: col.label,
        branchId: col.id,
        loc: { parentId: step.id, branch: col.id, index: 0 },
      }));
      exits.push({ col, lastId });
      left += l + r + BRANCH_GAP;
    });

    const colsH = Math.max(...colSizes.map((c) => c.h));
    nodes.push({
      id: joinId,
      kind: "join",
      blockId: step.id,
      x: cx - JOIN_SIZE / 2,
      y: branchTop + colsH + V_GAP,
      w: JOIN_SIZE,
      h: JOIN_SIZE,
    });
    for (const { col, lastId } of exits) {
      // A branch that ends in a Stop never rejoins: no edge, and no "+" after the Stop.
      const last = col.steps.at(-1);
      if (last && !last.disabled && idx.get(last.type)?.endsRun) continue;
      if (col.steps.length === 0) {
        edge({ kind: "join", source: lastId, target: joinId });
      } else {
        edge({
          kind: "join",
          source: lastId,
          target: joinId,
          loc: { parentId: step.id, branch: col.id, index: col.steps.length },
        });
      }
    }
    if (isLoop(step)) edge({ kind: "loopReturn", source: joinId, target: cardId });
    return joinId;
  }

  /**
   * Places a branch column centered on `cx` (a placeholder when the branch is empty), entering it
   * with the edge `enter(firstNodeId)`. Returns the ID of the column's last node.
   */
  function placeColumn(
    col: Column,
    parentId: string,
    cx: number,
    top: number,
    depth: number,
    enter: (target: string) => EdgeInput,
  ): string {
    if (col.steps.length > 0) {
      return placeStack(col.steps, { parentId, branch: col.id }, cx, top, depth, enter).last;
    }
    const id = `ph:${parentId}:${col.id}`;
    edge(enter(id));
    nodes.push({
      id,
      kind: "placeholder",
      loc: { parentId, branch: col.id, index: 0 },
      x: cx - CARD_W / 2,
      y: top,
      w: CARD_W,
      h: PLACEHOLDER_H,
    });
    return id;
  }

  /**
   * Stacks non-empty `steps` vertically on `cx` from `top`: the first is entered with
   * `enter(firstCardId)`, consecutive items are linked with `add` edges. The list's sections add
   * their header bands and bottom paddings, and their regions are recorded.
   */
  function placeStack(
    steps: Step[],
    list: { parentId: string | null; branch?: string },
    cx: number,
    top: number,
    depth: number,
    enter: (target: string) => EdgeInput,
  ): { last: string; bottom: number } {
    const m = marks.get(steps);
    const tops: number[] = [];
    let y = top;
    let prev = "";
    steps.forEach((s, i) => {
      if (m) y += (m.headers[i] as number) * SECTION_HEADER_H;
      const cardId = `step:${s.id}`;
      edge(
        i === 0
          ? enter(cardId)
          : { kind: "add", source: prev, target: cardId, loc: locAt(list, i) },
      );
      prev = placeItem(s, cx, y, depth);
      tops.push(y);
      y += measureItem(s).h + V_GAP;
      if (m) y += (m.pads[i] as number) * SECTION_PAD;
    });
    for (const sec of m?.sections ?? []) {
      let l = 0;
      let r = 0;
      for (let i = sec.start; i <= sec.end; i++) {
        const size = measureItem(steps[i] as Step);
        l = Math.max(l, size.l);
        r = Math.max(r, size.r);
      }
      const y0 = (tops[sec.start] as number) - SECTION_HEADER_H;
      const y1 = (tops[sec.end] as number) + measureItem(steps[sec.end] as Step).h + SECTION_PAD;
      regions[sec.order] = {
        id: sec.id,
        sectionId: sec.section.id,
        color: isAnnotationColor(sec.section.color) ? sec.section.color : "gray",
        x: cx - l - SECTION_PAD,
        y: y0,
        w: l + r + 2 * SECTION_PAD,
        h: y1 - y0,
        depth,
      };
    }
    return { last: prev, bottom: y - V_GAP };
  }

  // Root column: trigger, top-level steps, end.
  nodes.push({ id: "trigger", kind: "trigger", x: -CARD_W / 2, y: 0, w: CARD_W, h: CARD_H });
  const root = { parentId: null };
  let endTop = CARD_H + V_GAP;
  let lastId = "trigger";
  if (doc.steps.length > 0) {
    const stack = placeStack(doc.steps, root, 0, endTop, 0, (target) => ({
      kind: "add",
      source: "trigger",
      target,
      loc: locAt(root, 0),
    }));
    endTop = stack.bottom + V_GAP;
    lastId = stack.last;
  }
  nodes.push({
    id: "end",
    kind: "end",
    x: -JOIN_SIZE / 2,
    y: endTop,
    w: JOIN_SIZE,
    h: JOIN_SIZE,
  });
  edge({ kind: "add", source: lastId, target: "end", loc: locAt(root, doc.steps.length) });

  // Symmetric around x = 0, so fitting the viewport keeps the trigger centred.
  const rootCol = measureColumn(doc.steps);
  const width = 2 * Math.max(HALF, rootCol.l, rootCol.r);
  const sections = regions.filter((r): r is LayoutSection => r !== undefined);
  return { nodes, edges, sections, notes, width, height: endTop + JOIN_SIZE };
}

function locAt(list: { parentId: string | null; branch?: string }, index: number): StepLocation {
  return list.branch === undefined
    ? { parentId: list.parentId, index }
    : { parentId: list.parentId, branch: list.branch, index };
}

/** Whether `step` carries a note to show. An empty note counts as none. */
function hasNote(step: Step): boolean {
  return typeof step.note === "string" && step.note.length > 0;
}

/**
 * The valid sections of `doc`, grouped by the step list (by array identity) they run in, with
 * the space each list item needs. Broken sections are skipped.
 */
function sectionMarks(doc: WorkflowDoc): Map<Step[], ListMarks> {
  const out = new Map<Step[], ListMarks>();
  if (!Array.isArray(doc.sections) || doc.sections.length === 0) return out;
  const used = new Set<string>();
  doc.sections.forEach((section, order) => {
    const run = sectionRun(doc, section);
    if (!run) return;
    const list =
      run.parentId === null
        ? doc.steps
        : run.branch === undefined
          ? undefined
          : findStep(doc, run.parentId)?.step.branches?.[run.branch];
    if (!list || list[run.start]?.id !== section.first || list[run.end]?.id !== section.last) {
      return;
    }
    let m = out.get(list);
    if (!m) {
      m = {
        headers: list.map(() => 0),
        pads: list.map(() => 0),
        inside: list.map(() => false),
        sections: [],
      };
      out.set(list, m);
    }
    m.headers[run.start] = (m.headers[run.start] as number) + 1;
    m.pads[run.end] = (m.pads[run.end] as number) + 1;
    for (let i = run.start; i <= run.end; i++) m.inside[i] = true;
    let id = `section:${section.id}`;
    if (used.has(id)) id = `${id}~${order}`;
    used.add(id);
    m.sections.push({ order, id, section, start: run.start, end: run.end });
  });
  return out;
}
