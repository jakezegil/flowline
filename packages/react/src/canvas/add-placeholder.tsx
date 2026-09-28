import type { StepLocation } from "@flowkit/core";
import type { Node, NodeProps } from "@xyflow/react";
import { Plus } from "lucide-react";
import { memo } from "react";
import { useCanvasUi, useLabels } from "./canvas-context";
import { NodeHandles } from "./handles";

/** Data of an empty-branch placeholder node. */
export interface PlaceholderNodeData extends Record<string, unknown> {
  loc: StepLocation;
}

/** An empty-branch placeholder node. */
export type PlaceholderNode = Node<PlaceholderNodeData, "placeholder">;

/**
 * The dashed "Add step" card of an empty branch: opens the step picker to insert there. In
 * read-only mode it only marks the branch as empty.
 */
export const AddPlaceholder = memo(function AddPlaceholder({ data }: NodeProps<PlaceholderNode>) {
  const readOnly = useCanvasUi((s) => s.readOnly);
  const openPicker = useCanvasUi((s) => s.openPicker);
  const labels = useLabels();
  const active = useCanvasUi(
    (s) =>
      s.picker?.request.mode === "insert" &&
      s.picker.request.loc.parentId === data.loc.parentId &&
      s.picker.request.loc.branch === data.loc.branch,
  );
  if (readOnly) {
    return (
      <>
        <NodeHandles />
        <div className="fk-placeholder" data-readonly>
          {labels.noSteps}
        </div>
      </>
    );
  }
  return (
    <>
      <NodeHandles />
      <button
        type="button"
        className="fk-placeholder nodrag nopan"
        data-active={active || undefined}
        onClick={(e) => {
          e.stopPropagation();
          openPicker({ mode: "insert", loc: data.loc }, e.currentTarget);
        }}
      >
        <Plus size={14} strokeWidth={2.5} aria-hidden />
        <span>{labels.addStep}</span>
      </button>
    </>
  );
});
