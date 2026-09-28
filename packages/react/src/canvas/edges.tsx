import type { StepLocation } from "@flowkit/core";
import { type Edge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import { Plus, TriangleAlert } from "lucide-react";
import { type CSSProperties, memo } from "react";
import type { LayoutEdge } from "../layout/layout-tree";
import { useCanvasUi } from "./canvas-context";
import type { EdgeGeometry, Point } from "./geometry";

/** Data of every canvas edge. */
export interface FlowEdgeData extends Record<string, unknown> {
  edge: LayoutEdge;
  geometry: EdgeGeometry;
  /** Branch edges: the branch isn't declared by the step's node type (a leftover). */
  leftover?: boolean;
  /** Branch edges: the label shown in the pill. */
  label?: string;
  /** Branch edges: the step that branches here. */
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
  const active = useCanvasUi(
    (s) => s.picker?.request.mode === "insert" && sameLoc(s.picker.request.loc, loc),
  );
  if (readOnly) return null;
  return (
    <div className="fk-edge-ctl nodrag nopan" style={at(p)}>
      <button
        type="button"
        className="fk-add"
        aria-label="Add step here"
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
      className={className ? `fk-edge ${className}` : "fk-edge"}
      d={d}
      style={{ d: `path("${d}")` } as CSSProperties}
      fill="none"
    />
  );
}

function useDimmed(id: string, blockId: string | undefined): boolean {
  return useCanvasUi((s) => {
    const o = s.overlay;
    if (!o || blockId === undefined) return false;
    const status = o.stepStatus[blockId]?.status;
    return (status === "done" || status === "failed") && !o.takenEdges.has(id);
  });
}

/** A straight edge between consecutive nodes of a column, with a "+" at its midpoint. */
export const AddEdge = memo(function AddEdge({ data }: EdgeProps<FlowEdge>) {
  if (!data) return null;
  const { geometry, edge } = data;
  return (
    <>
      <EdgePath d={geometry.path} />
      {geometry.plus && edge.kind === "add" && (
        <EdgeLabelRenderer>
          <AddButton p={geometry.plus} loc={edge.loc} />
        </EdgeLabelRenderer>
      )}
    </>
  );
});

/** An edge from a block into one of its branch columns, with the branch's label pill and "+". */
export const BranchEdge = memo(function BranchEdge({ id, data }: EdgeProps<FlowEdge>) {
  const dimmed = useDimmed(id, data?.blockId);
  if (data?.edge.kind !== "branch") return null;
  const { geometry, edge, leftover, label } = data;
  return (
    <>
      <EdgePath d={geometry.path} className={dimmed ? "fk-edge--dimmed" : undefined} />
      <EdgeLabelRenderer>
        {geometry.label && (
          <div
            className="fk-branch-label nodrag nopan"
            data-leftover={leftover || undefined}
            data-dimmed={dimmed || undefined}
            style={at(geometry.label)}
            title={
              leftover
                ? `The "${edge.branchId}" branch isn't part of this step's type anymore. Move or delete its steps.`
                : undefined
            }
          >
            {leftover && <TriangleAlert size={11} aria-hidden />}
            <span>{leftover ? `Leftover: ${label}` : label}</span>
          </div>
        )}
        {geometry.plus && <AddButton p={geometry.plus} loc={edge.loc} />}
      </EdgeLabelRenderer>
    </>
  );
});

/** An edge from the end of a branch column into the block's join; "+" appends to the branch. */
export const JoinEdge = memo(function JoinEdge({ id, data }: EdgeProps<FlowEdge>) {
  const dimmed = useDimmed(id, data?.blockId);
  if (data?.edge.kind !== "join") return null;
  const { geometry, edge } = data;
  return (
    <>
      <EdgePath d={geometry.path} className={dimmed ? "fk-edge--dimmed" : undefined} />
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
  return <EdgePath d={data.geometry.path} className="fk-edge--loop" />;
});

/** Edge components by type. */
export const edgeTypes = {
  add: AddEdge,
  branch: BranchEdge,
  join: JoinEdge,
  loopReturn: LoopReturnEdge,
};
