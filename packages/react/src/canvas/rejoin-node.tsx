import type { Node, NodeProps } from "@xyflow/react";
import { memo } from "react";
import { useLabels } from "./canvas-context";
import { NodeHandles } from "./handles";

/** A join node, where a block's branches (or a loop's body) rejoin. */
export type JoinNode = Node<{ blockId: string }, "join">;

/** The end-of-workflow node. */
export type EndNode = Node<Record<string, never>, "end">;

/** The small dot where branch columns merge back into one. */
export const RejoinNode = memo(function RejoinNode(_: NodeProps<JoinNode>) {
  return (
    <>
      <NodeHandles />
      <div className="fl-join" aria-hidden />
    </>
  );
});

/** The end of the workflow: a dot with an "End" caption. */
export const EndNode = memo(function EndNode(_: NodeProps<EndNode>) {
  const labels = useLabels();
  return (
    <div className="fl-end">
      <NodeHandles />
      <span className="fl-end__label">{labels.end}</span>
    </div>
  );
});
