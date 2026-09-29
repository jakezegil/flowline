/**
 * A step's sticky note, pinned to the right of its card.
 *
 * @module
 */
import type { Node, NodeProps } from "@xyflow/react";
import { type JSX, memo } from "react";
import { stepIndex, useEditorStore } from "../hooks";
import { drawColor } from "./section-node";

/** Data of a note node. */
export interface NoteNodeData extends Record<string, unknown> {
  /** The step the note belongs to. */
  stepId: string;
}

/** A sticky-note node. */
export type NoteNode = Node<NoteNodeData, "note">;

/**
 * A step's note: its first three lines on the step's colour (yellow when it has none), with the
 * whole text as the tooltip. The node itself is focusable and named "Note: …".
 */
export const NoteCard = memo(function NoteCard({ data }: NodeProps<NoteNode>): JSX.Element | null {
  const note = useEditorStore((s) => stepIndex(s.doc).get(data.stepId)?.note);
  const color = useEditorStore((s) => stepIndex(s.doc).get(data.stepId)?.color);
  if (typeof note !== "string" || note === "") return null;
  return (
    <div
      className="fl-note"
      data-color={color === undefined ? "yellow" : drawColor(color)}
      title={note}
    >
      <div className="fl-note__text">{note}</div>
    </div>
  );
});
