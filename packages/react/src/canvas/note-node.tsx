/**
 * A step's sticky note, pinned to the right of its card. In the editor a click (or Enter on the
 * focused note) edits it inline; a note that is too long offers Shorten.
 *
 * @module
 */
import type { Node, NodeProps } from "@xyflow/react";
import { type JSX, memo, useContext, useMemo } from "react";
import { stepIndex, useEditorStore, useEditorStoreApi } from "../hooks";
import { focusNode, nodeElement, noteActions, tooLongNote } from "./actions";
import { RootElementContext, useCanvasUi, useCanvasUiApi, useLabels } from "./canvas-context";
import { NoteEditor, savedNote } from "./note-editor";
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
 * whole text as the tooltip. The node itself is focusable and named "Note: …". While the note is
 * being edited (`editingNote`), the node shows the inline editor, also for a step without a note
 * yet (the canvas then lays out a note for it).
 */
export const NoteCard = memo(function NoteCard({ data }: NodeProps<NoteNode>): JSX.Element | null {
  const { stepId } = data;
  const store = useEditorStoreApi();
  const ui = useCanvasUiApi();
  const root = useContext(RootElementContext);
  const labels = useLabels();
  const note = useEditorStore((s) => stepIndex(s.doc).get(stepId)?.note);
  const color = useEditorStore((s) => stepIndex(s.doc).get(stepId)?.color);
  const readOnly = useEditorStore((s) => s.readOnly);
  const tooLong = useEditorStore((s) => tooLongNote(s.issues, stepId) !== undefined);
  const editing = useCanvasUi((s) => s.editingNote === stepId) && !readOnly;
  const actions = useMemo(() => noteActions(store, ui, root, stepId), [store, ui, root, stepId]);
  const text = typeof note === "string" ? note : "";
  if (text === "" && !editing) return null;
  const tone = color === undefined ? "yellow" : drawColor(color);
  if (editing) {
    return (
      <div className="fl-note" data-color={tone} data-editing="">
        <NoteEditor
          initial={text}
          label={labels.editNote}
          onDone={(value, keyboard) => {
            ui.getState().stopNoteEdit();
            if (value !== null) store.getState().setNote(stepId, savedNote(value));
            if (!keyboard) return;
            // Back to the note when it is still there, else to its card.
            requestAnimationFrame(() => {
              // An editor opened meanwhile keeps focus.
              if (ui.getState().editingNote !== null) return;
              const noteNode = nodeElement(root(), `note:${stepId}`);
              if (noteNode) noteNode.focus({ preventScroll: true });
              else focusNode(root(), stepId);
            });
          }}
        />
      </div>
    );
  }
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Enter on the focused note node edits it (canvas keys).
    // biome-ignore lint/a11y/noStaticElementInteractions: a click edits the note; the node itself is the focusable control.
    <div
      className="fl-note"
      data-color={tone}
      data-editable={readOnly ? undefined : ""}
      title={text}
      onClick={readOnly ? undefined : actions.edit}
    >
      <div className="fl-note__text">{text}</div>
      {tooLong && !readOnly && (
        <button
          type="button"
          className="fl-note__shorten nodrag nopan"
          onClick={(e) => {
            e.stopPropagation();
            actions.shorten();
          }}
        >
          {labels.shortenNote}
        </button>
      )}
    </div>
  );
});
