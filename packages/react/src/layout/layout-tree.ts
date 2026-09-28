import {
  branchesFor,
  type Manifest,
  type NodeManifest,
  type Step,
  type StepLocation,
  type WorkflowDoc,
} from "@flowkit/core";
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

/** A {@link LayoutEdge} before its ID is derived. */
type EdgeInput = LayoutEdge extends infer E
  ? E extends LayoutEdge
    ? Omit<E, "id">
    : never
  : never;

interface Size {
  w: number;
  h: number;
}

interface Column {
  id: string;
  label: string;
  steps: Step[];
}

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
 * @returns Nodes (pre-order), edges, and the overall `width` (centered on `x = 0`) and `height`.
 */
export function layoutTree(
  doc: WorkflowDoc,
  manifest: Manifest,
): { nodes: LayoutNode[]; edges: LayoutEdge[]; width: number; height: number } {
  const idx = nodeIndex(manifest);
  const nodes: LayoutNode[] = [];
  const edges: LayoutEdge[] = [];
  const sizes = new Map<Step, Size>();
  const columnCache = new Map<Step, Column[]>();

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

  function measureColumn(steps: Step[]): Size {
    if (steps.length === 0) return { w: CARD_W, h: PLACEHOLDER_H };
    let w = 0;
    let h = 0;
    for (const s of steps) {
      const size = measureItem(s);
      w = Math.max(w, size.w);
      h += size.h;
    }
    return { w, h: h + V_GAP * (steps.length - 1) };
  }

  function measureItem(step: Step): Size {
    const cached = sizes.get(step);
    if (cached) return cached;
    const cols = columnsOf(step);
    let size: Size;
    if (cols.length === 0) {
      size = { w: CARD_W, h: CARD_H };
    } else {
      const colSizes = cols.map((c) => measureColumn(c.steps));
      const inner = colSizes.reduce((sum, c) => sum + c.w, 0) + BRANCH_GAP * (colSizes.length - 1);
      const colsH = Math.max(...colSizes.map((c) => c.h));
      size = {
        w: Math.max(CARD_W, inner + (isLoop(step) ? 2 * LOOP_GUTTER : 0)),
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
    const cols = columnsOf(step);
    if (cols.length === 0) return cardId;

    const colSizes = cols.map((c) => measureColumn(c.steps));
    const inner = colSizes.reduce((sum, c) => sum + c.w, 0) + BRANCH_GAP * (cols.length - 1);
    const branchTop = top + CARD_H + V_GAP + LABEL_H;
    const joinId = `join:${step.id}`;
    const exits: { col: Column; lastId: string }[] = [];
    let left = cx - inner / 2;
    cols.forEach((col, i) => {
      const w = (colSizes[i] as Size).w;
      const lastId = placeColumn(col, step.id, left + w / 2, branchTop, depth + 1, (target) => ({
        kind: "branch",
        source: cardId,
        target,
        label: col.label,
        branchId: col.id,
        loc: { parentId: step.id, branch: col.id, index: 0 },
      }));
      exits.push({ col, lastId });
      left += w + BRANCH_GAP;
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
   * `enter(firstCardId)`, consecutive items are linked with `add` edges.
   */
  function placeStack(
    steps: Step[],
    list: { parentId: string | null; branch?: string },
    cx: number,
    top: number,
    depth: number,
    enter: (target: string) => EdgeInput,
  ): { last: string; bottom: number } {
    let y = top;
    let prev = "";
    steps.forEach((s, i) => {
      const cardId = `step:${s.id}`;
      edge(
        i === 0
          ? enter(cardId)
          : { kind: "add", source: prev, target: cardId, loc: locAt(list, i) },
      );
      prev = placeItem(s, cx, y, depth);
      y += measureItem(s).h + V_GAP;
    });
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

  const width = Math.max(CARD_W, ...doc.steps.map((s) => measureItem(s).w));
  return { nodes, edges, width, height: endTop + JOIN_SIZE };
}

function locAt(list: { parentId: string | null; branch?: string }, index: number): StepLocation {
  return list.branch === undefined
    ? { parentId: list.parentId, index }
    : { parentId: list.parentId, branch: list.branch, index };
}
