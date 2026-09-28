import type { StepLocation } from "@flowlinejs/core";
import { type Edge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import { Plus, TriangleAlert } from "lucide-react";
import { type CSSProperties, memo } from "react";
import { useEditorStore } from "../hooks";
import type { LayoutEdge } from "../layout/layout-tree";
import { insertLabel } from "./actions";
import { useCanvasUi, useLabels } from "./canvas-context";
import type { EdgeGeometry, Point } from "./geometry";

/** Data of every canvas edge. */
export interface FlowEdgeData extends Record<string, unknown> {
  edge: LayoutEdge;
  geometry: EdgeGeometry;
  /** Branch edges: the branch isn't declared by the step's node type (a leftover). */
  leftover?: boolean;
  /** Branch edges: the label shown in the pill. */
  label?: string;
  /** Branch and join edges: the step that branches (or rejoins) here. */
  blockId?: string;
}

/** A canvas edge. */
export type FlowEdge = Edge<FlowEdgeData>;

function sameLoc(a: StepLocation, b: StepLocation): boolean {
  return a.parentId === b.parentId && a.branch === b.branch && a.index === b.index;
}

/** Style placing an HTML edge control centered on `p` (animates with the layout). */
function at(p: Point): CSSProperties {
  return { transform: `translate(-50%, -50%) translate(${p.x}px, ${p.y}px)` };
}

/** The "+" insertion button on an edge. Hidden in read-only mode. */
function AddButton({ p, loc }: { p: Point; loc: StepLocation }) {
  const readOnly = useCanvasUi((s) => s.readOnly);
  const openPicker = useCanvasUi((s) => s.openPicker);
  const labels = useLabels();
  const active = useCanvasUi(
    (s) => s.picker?.request.mode === "insert" && sameLoc(s.picker.request.loc, loc),
  );
  const name = useEditorStore((s) => insertLabel(s.doc, s.manifest, loc, labels));
  if (readOnly) return null;
  return (
    <div className="fl-edge-ctl nodrag nopan" style={at(p)}>
      {/* Out of the tab order (they'd all come before the cards): from the keyboard, ⌘K adds a
          step after the focused card and ⇧⌘K before it. */}
      <button
        type="button"
        className="fl-add"
        tabIndex={-1}
        aria-label={name}
        title={name}
        data-insert-at={`${loc.parentId ?? ""}/${loc.branch ?? ""}/${loc.index}`}
        data-active={active || undefined}
        onClick={(e) => {
          e.stopPropagation();
          openPicker({ mode: "insert", loc }, e.currentTarget);
        }}
      >
        <Plus size={12} strokeWidth={2.5} aria-hidden />
      </button>
    </div>
  );
}

/** The path of an edge. `d` is also set as a CSS property so layout changes can transition. */
function EdgePath({ d, className }: { d: string; className?: string }) {
  return (
    <path
      className={className ? `fl-edge ${className}` : "fl-edge"}
      d={d}
      style={{ d: `path("${d}")` } as CSSProperties}
      fill="none"
    />
  );
}

/** The step ID behind a node ID (`step:x`, `join:x`), if any. */
function stepOfNode(nodeId: string): string | undefined {
  if (nodeId.startsWith("step:")) return nodeId.slice(5);
  if (nodeId.startsWith("join:")) return nodeId.slice(5);
  return undefined;
}

/**
 * Whether an edge is on a path the run didn't take: it touches a dimmed step, or it is a branch
 * or join edge of a block that took another branch (or finished without entering this one).
 */
function useDimmed(edge: LayoutEdge | undefined, blockId: string | undefined): boolean {
  return useCanvasUi((s) => {
    const o = s.overlay;
    if (!o || !edge) return false;
    const dimmed = o.dimmedSteps;
    if (dimmed) {
      const a = stepOfNode(edge.source);
      const b = stepOfNode(edge.target);
      if ((a !== undefined && dimmed.has(a)) || (b !== undefined && dimmed.has(b))) return true;
    }
    if (blockId === undefined || o.takenEdges.has(edge.id)) return false;
    const status = o.stepStatus[blockId]?.status;
    if (status === "done" || status === "failed") return true;
    const prefix = `step:${blockId}->`;
    for (const taken of o.takenEdges) if (taken.startsWith(prefix)) return true;
    return false;
  });
}

/** A straight edge between consecutive nodes of a column, with a "+" at its midpoint. */
export const AddEdge = memo(function AddEdge({ data }: EdgeProps<FlowEdge>) {
  const dimmed = useDimmed(data?.edge, undefined);
  if (!data) return null;
  const { geometry, edge } = data;
  return (
    <>
      <EdgePath d={geometry.path} className={dimmed ? "fl-edge--dimmed" : undefined} />
      {geometry.plus && edge.kind === "add" && (
        <EdgeLabelRenderer>
          <AddButton p={geometry.plus} loc={edge.loc} />
        </EdgeLabelRenderer>
      )}
    </>
  );
});

/** An edge from a block into one of its branch columns, with the branch's label pill and "+". */
export const BranchEdge = memo(function BranchEdge({ data }: EdgeProps<FlowEdge>) {
  const dimmed = useDimmed(data?.edge, data?.blockId);
  const labels = useLabels();
  if (data?.edge.kind !== "branch") return null;
  const { geometry, edge, leftover, label } = data;
  return (
    <>
      <EdgePath d={geometry.path} className={dimmed ? "fl-edge--dimmed" : undefined} />
      <EdgeLabelRenderer>
        {geometry.label && (
          <div
            className="fl-branch-label nodrag nopan"
            data-leftover={leftover || undefined}
            data-dimmed={dimmed || undefined}
            style={at(geometry.label)}
            title={leftover ? labels.leftoverBranchHint(edge.branchId) : undefined}
          >
            {leftover && <TriangleAlert size={11} aria-hidden />}
            <span>{leftover ? labels.leftoverBranch(label ?? edge.branchId) : label}</span>
          </div>
        )}
        {geometry.plus && <AddButton p={geometry.plus} loc={edge.loc} />}
      </EdgeLabelRenderer>
    </>
  );
});

/** An edge from the end of a branch column into the block's join; "+" appends to the branch. */
export const JoinEdge = memo(function JoinEdge({ data }: EdgeProps<FlowEdge>) {
  const dimmed = useDimmed(data?.edge, data?.blockId);
  if (data?.edge.kind !== "join") return null;
  const { geometry, edge } = data;
  return (
    <>
      <EdgePath d={geometry.path} className={dimmed ? "fl-edge--dimmed" : undefined} />
      {geometry.plus && edge.loc && (
        <EdgeLabelRenderer>
          <AddButton p={geometry.plus} loc={edge.loc} />
        </EdgeLabelRenderer>
      )}
    </>
  );
});

/** The dashed edge from a loop's join back up to the loop card. */
export const LoopReturnEdge = memo(function LoopReturnEdge({ data }: EdgeProps<FlowEdge>) {
  if (!data) return null;
  return <EdgePath d={data.geometry.path} className="fl-edge--loop" />;
});

/** Edge components by type. */
export const edgeTypes = {
  add: AddEdge,
  branch: BranchEdge,
  join: JoinEdge,
  loopReturn: LoopReturnEdge,
};
