/**
 * Edge geometry for the tree layout. Paths are computed from layout positions (not from xyflow
 * handle positions) and every path of one edge kind has the same command structure, so a CSS
 * transition on `d` interpolates them smoothly while cards animate to new positions.
 *
 * @module
 */

import type { LayoutEdge, LayoutNode } from "../layout/layout-tree";

/** Corner radius of edge bends. */
const R = 8;
/** Distance below a block's card where its branch edges fork. */
export const FORK_DY = 16;
/** Distance above a join node where branch columns merge. */
export const MERGE_DY = 16;
/** Branch label pill center, below the block card's bottom. */
export const LABEL_DY = 36;
/** "+" button center on a branch edge, below the block card's bottom. */
export const BRANCH_PLUS_DY = 62;

/** A point in canvas coordinates. */
export interface Point {
  x: number;
  y: number;
}

/** Drawing instructions of one edge: its SVG path and where its controls sit. */
export interface EdgeGeometry {
  path: string;
  /** Center of the "+" button, when the edge has an insertion point. */
  plus?: Point;
  /** Center of the branch label pill (branch edges). */
  label?: Point;
}

const n = (v: number) => Math.round(v * 100) / 100;

/**
 * A vertical–horizontal–vertical path from `a` down to `b`, turning at height `turnY` with
 * rounded corners. Degenerates to a straight line (same command structure) when `a.x === b.x`.
 */
function elbow(a: Point, b: Point, turnY: number): string {
  const dx = b.x - a.x;
  const dir = Math.sign(dx);
  const r = Math.min(R, Math.abs(dx) / 2, Math.abs(turnY - a.y), Math.abs(b.y - turnY));
  return [
    `M ${n(a.x)} ${n(a.y)}`,
    `L ${n(a.x)} ${n(turnY - r)}`,
    `Q ${n(a.x)} ${n(turnY)} ${n(a.x + dir * r)} ${n(turnY)}`,
    `L ${n(b.x - dir * r)} ${n(turnY)}`,
    `Q ${n(b.x)} ${n(turnY)} ${n(b.x)} ${n(turnY + r)}`,
    `L ${n(b.x)} ${n(b.y)}`,
  ].join(" ");
}

const bottomCenter = (node: LayoutNode): Point => ({ x: node.x + node.w / 2, y: node.y + node.h });
const topCenter = (node: LayoutNode): Point => ({ x: node.x + node.w / 2, y: node.y });

/** An axis-aligned rectangle in canvas coordinates (top-left corner and size). */
export interface CanvasRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Left edge (in x) of the widest thing inside loop `blockId`'s body: the nodes laid out between
 * its card and its join node (pre-order), or its own card when the body is narrower. Obstacles
 * (such as section regions) that lie within the loop's height, between its card and its join, and
 * overlap the body horizontally count too, so the return route passes left of them.
 */
function loopBodyLeft(
  nodes: LayoutNode[],
  blockId: string,
  obstacles: readonly CanvasRect[],
): number {
  const start = nodes.findIndex((nd) => nd.id === `step:${blockId}`);
  const end = nodes.findIndex((nd) => nd.id === `join:${blockId}`);
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (let i = start; i >= 0 && i < end; i++) {
    const nd = nodes[i] as LayoutNode;
    left = Math.min(left, nd.x);
    right = Math.max(right, nd.x + nd.w);
  }
  if (obstacles.length === 0 || start < 0 || end < 0) return left;
  const top = (nodes[start] as LayoutNode).y;
  const join = nodes[end] as LayoutNode;
  const bottom = join.y + join.h;
  let bodyLeft = left;
  for (const o of obstacles) {
    const within = o.y >= top && o.y + o.h <= bottom;
    if (within && o.x < right && o.x + o.w > left) bodyLeft = Math.min(bodyLeft, o.x);
  }
  return bodyLeft;
}

/**
 * Computes the geometry of every layout edge.
 * @param gutter Width reserved beside a loop's body for its `loopReturn` route.
 * @param obstacles Rects the `loopReturn` route must pass left of, such as section regions.
 * @returns Geometry by edge ID.
 */
export function edgeGeometries(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  gutter: number,
  obstacles: readonly CanvasRect[] = [],
): Map<string, EdgeGeometry> {
  const byId = new Map(nodes.map((nd) => [nd.id, nd]));
  const out = new Map<string, EdgeGeometry>();
  for (const e of edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    switch (e.kind) {
      case "add": {
        const a = bottomCenter(s);
        const b = topCenter(t);
        out.set(e.id, {
          path: `M ${n(a.x)} ${n(a.y)} L ${n(b.x)} ${n(b.y)}`,
          plus: { x: a.x, y: (a.y + b.y) / 2 },
        });
        break;
      }
      case "branch": {
        const a = bottomCenter(s);
        const b = topCenter(t);
        out.set(e.id, {
          path: elbow(a, b, a.y + FORK_DY),
          label: { x: b.x, y: a.y + LABEL_DY },
          plus: { x: b.x, y: a.y + BRANCH_PLUS_DY },
        });
        break;
      }
      case "join": {
        const a = bottomCenter(s);
        const b = topCenter(t);
        const geometry: EdgeGeometry = { path: elbow(a, b, b.y - MERGE_DY) };
        if (e.loc) geometry.plus = { x: a.x, y: a.y + Math.min(28, (b.y - MERGE_DY - a.y) / 2) };
        out.set(e.id, geometry);
        break;
      }
      case "loopReturn": {
        // From the join's left side out to the gutter, up, and into the loop card's left side.
        const blockId = t.kind === "step" ? t.stepId : "";
        const gx = loopBodyLeft(nodes, blockId, obstacles) - gutter / 2;
        const from: Point = { x: s.x, y: s.y + s.h / 2 };
        const to: Point = { x: t.x, y: t.y + t.h / 2 };
        const r = Math.min(R, Math.abs(from.x - gx) / 2, Math.abs(to.x - gx) / 2);
        out.set(e.id, {
          path: [
            `M ${n(from.x)} ${n(from.y)}`,
            `L ${n(gx + r)} ${n(from.y)}`,
            `Q ${n(gx)} ${n(from.y)} ${n(gx)} ${n(from.y - r)}`,
            `L ${n(gx)} ${n(to.y + r)}`,
            `Q ${n(gx)} ${n(to.y)} ${n(gx + r)} ${n(to.y)}`,
            `L ${n(to.x)} ${n(to.y)}`,
          ].join(" "),
        });
        break;
      }
    }
  }
  return out;
}
