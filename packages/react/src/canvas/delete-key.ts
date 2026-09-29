/**
 * Backspace/Delete: what a keydown deletes (a step, the range, a section or a note) and doing
 * it, for the canvas root's key handler and for keys from the rest of the editor (its side panel
 * and `<body>` after a click in the editor).
 *
 * @module
 */

import { findStep } from "@flowlinejs/core";
import { createContext } from "react";
import { type EditorStore, TRIGGER_KEY } from "../store/editor-store";
import {
  noteActions,
  occurrenceIndex,
  rangeActions,
  safeEdit,
  sectionActions,
  stepActions,
} from "./actions";
import type { CanvasUiStore } from "./canvas-context";

/**
 * Whether a key event comes from somewhere keys mean text or menu navigation: form fields,
 * contenteditable, CodeMirror, and open menus, dialogs or the step picker.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return (
    target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .cm-editor, [role="menu"], [role="dialog"], [role="listbox"], [cmdk-root]',
    ) !== null
  );
}

/**
 * The selection key ({@link TRIGGER_KEY} or a step ID) of the canvas card an event comes from, or
 * `undefined` when it doesn't come from a card.
 */
export function focusedKey(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined;
  const id = target.closest(".react-flow__node")?.getAttribute("data-id");
  if (id === "trigger") return TRIGGER_KEY;
  return id?.startsWith("step:") ? id.slice(5) : undefined;
}

/** What a Delete/Backspace keydown deletes (see {@link deleteTarget}). */
export type DeleteTarget =
  | { kind: "step"; id: string }
  | { kind: "range"; first: string; last: string }
  /** `id` is the header's occurrence key: the section ID, or `<id>~<index>` for a repeated ID. */
  | { kind: "section"; id: string }
  | { kind: "note"; stepId: string };

/**
 * Canvas buttons on which Backspace/Delete delete the selection (S15): the card's "…" menu
 * trigger and the "+" insert buttons. Every other button in the canvas (toast actions, the
 * RangeBar, zoom controls, a note's Shorten) keeps the key.
 */
const DELETING_BUTTONS = ".fl-card__kebab, .fl-add, .fl-placeholder";

/** The canvas node ID an event comes from (`"step:a"`, `"note:a"`, …), if any. */
function nodeIdOf(target: Element): string {
  return target.closest(".react-flow__node")?.getAttribute("data-id") ?? "";
}

/**
 * What a Delete/Backspace keydown should delete, or null when the key belongs to a text control
 * or nothing applies. In order: only Delete or Backspace without ⌘/Ctrl/⌥ count; never from an
 * editable target (inputs, textareas, selects, contenteditable, CodeMirror, open menus, dialogs,
 * listboxes, the step picker) or on a read-only store; a section's header chip deletes that
 * section; toast buttons and canvas buttons other than "…" and "+" keep the key; a note deletes
 * that note; then the range, when focus is on one of its cards or on no card (else the focused
 * card); then the focused card, else the selected step. The trigger is never deleted.
 *
 * `state.members` are the range's step IDs (`rangeIds`); without them only the range's ends
 * count as its cards.
 */
export function deleteTarget(
  e: {
    key: string;
    target: EventTarget | null;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
  },
  state: {
    selection: string | null;
    range: { first: string; last: string } | null;
    readOnly: boolean;
    members?: ReadonlySet<string>;
  },
): DeleteTarget | null {
  if (e.key !== "Delete" && e.key !== "Backspace") return null;
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (isEditableTarget(e.target) || state.readOnly) return null;
  const el = e.target instanceof Element ? e.target : null;
  const nodeId = el ? nodeIdOf(el) : "";
  if (nodeId.startsWith("sectionHeader:")) {
    return { kind: "section", id: nodeId.slice("sectionHeader:".length) };
  }
  if (el?.closest(".fl-toasts")) return null;
  const control = el?.closest('button, a[href], [role="tab"], [role="menuitem"]');
  if (
    control?.closest(".fl-canvas") &&
    !control.classList.contains("react-flow__node") &&
    !control.matches(DELETING_BUTTONS)
  ) {
    return null;
  }
  if (nodeId.startsWith("note:")) return { kind: "note", stepId: nodeId.slice("note:".length) };
  const focused = focusedKey(el);
  const { range } = state;
  if (range !== null) {
    const inRange = (id: string) =>
      state.members ? state.members.has(id) : id === range.first || id === range.last;
    if (focused === undefined || inRange(focused)) {
      return { kind: "range", first: range.first, last: range.last };
    }
  }
  const id = focused ?? state.selection;
  return id === null || id === TRIGGER_KEY ? null : { kind: "step", id };
}

/**
 * Deletes `target` with its undo toast, moving focus to what takes its place (see the actions).
 * Never throws for a rejected edit: a `FlowlineCommandError` (e.g. the store turned read-only)
 * becomes a toast. A stale target (a step or section no longer in the doc) does nothing.
 */
export function runDelete(
  target: DeleteTarget,
  deps: { store: EditorStore; ui: CanvasUiStore; root(): HTMLElement | null },
): void {
  const { store, ui, root } = deps;
  const { doc } = store.getState();
  safeEdit(ui, () => {
    switch (target.kind) {
      case "step":
        if (findStep(doc, target.id)) stepActions(store, ui, root, target.id).remove();
        return;
      case "range":
        rangeActions(store, ui, root)?.remove();
        return;
      case "section": {
        const at = occurrenceIndex(doc, target.id);
        const sectionId = at === -1 ? undefined : doc.sections?.[at]?.id;
        // An earlier occurrence of a repeated ID: `ungroup` is a no-op there (only Fix applies).
        if (sectionId !== undefined) {
          sectionActions(store, ui, root, sectionId, target.id).ungroup();
        }
        return;
      }
      case "note":
        noteActions(store, ui, root, target.stepId).remove();
        return;
    }
  });
}

/**
 * Internal: the element (editor body) whose keydowns outside the canvas root the canvas also
 * handles.
 */
export const DeleteScopeContext = createContext<HTMLElement | null>(null);
