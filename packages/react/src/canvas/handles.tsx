import { Handle, Position } from "@xyflow/react";

/**
 * Invisible connection points xyflow needs to attach edges (it measures them from the DOM).
 * Edges are drawn from layout geometry, so their position doesn't matter; users can't connect.
 */
export function NodeHandles() {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} className="fl-handle" />
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="fl-handle"
      />
    </>
  );
}
