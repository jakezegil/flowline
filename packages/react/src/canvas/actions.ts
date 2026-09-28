/**
 * Step commands shared by the context menu, the kebab menu and keyboard shortcuts, so each
 * action behaves the same however it is triggered.
 *
 * @module
 */

import { findStep, type StepLocation } from "@flowkit/core";
import { type EditorStore, TRIGGER_KEY } from "../store/editor-store";
import type { CanvasUiStore } from "./canvas-context";

/** The DOM element of a canvas node (`"trigger"`, `"step:<id>"`, …) inside `root`. */
export function nodeElement(root: HTMLElement | null, nodeId: string): HTMLElement | null {
  if (!root) return null;
  const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(nodeId) : nodeId;
  return root.querySelector<HTMLElement>(`.react-flow__node[data-id="${escaped}"]`);
}

/** Canvas node ID of a selection key (a step ID or {@link TRIGGER_KEY}). */
export function nodeIdOf(key: string): string {
  return key === TRIGGER_KEY ? "trigger" : `step:${key}`;
}

/** Focuses the canvas node of `key` once the next layout has rendered. */
export function focusNode(root: HTMLElement | null, key: string): void {
  requestAnimationFrame(() => nodeElement(root, nodeIdOf(key))?.focus({ preventScroll: true }));
}

/**
 * Where a pasted or inserted step goes relative to the selection: right after a selected step,
 * at the top when the trigger is selected, at the end when nothing is.
 */
export function locationAfter(store: EditorStore, selection: string | null): StepLocation {
  const { doc } = store.getState();
  if (selection === TRIGGER_KEY) return { parentId: null, index: 0 };
  const found = selection ? findStep(doc, selection) : undefined;
  if (!found) return { parentId: null, index: doc.steps.length };
  const { parentId, branch, index } = found.location;
  return branch === undefined
    ? { parentId, index: index + 1 }
    : { parentId, branch, index: index + 1 };
}

/** The actions available on a step card. */
export interface StepActions {
  rename(): void;
  duplicate(): void;
  copyReference(): void;
  replace(): void;
  toggleDisabled(): void;
  copy(): void;
  pasteAfter(): void;
  /** Pastes at the top of `branch` of this step (its loop body for loops). */
  pasteInside(branch: string): void;
  remove(): void;
}

/**
 * Where selection goes when `stepId` is deleted: the next step in its list, else the previous
 * one, else the step that owns the list (or the trigger at the top level).
 */
function neighbourOf(store: EditorStore, stepId: string): string {
  const { doc } = store.getState();
  const found = findStep(doc, stepId);
  if (!found) return TRIGGER_KEY;
  const { parentId, branch, index } = found.location;
  const owner = found.ancestors[found.ancestors.length - 1]?.step;
  const list = parentId === null ? doc.steps : (owner?.branches?.[branch ?? ""] ?? []);
  return list[index + 1]?.id ?? list[index - 1]?.id ?? parentId ?? TRIGGER_KEY;
}

/** Binds the step actions of `stepId`. */
export function stepActions(
  store: EditorStore,
  ui: CanvasUiStore,
  root: () => HTMLElement | null,
  stepId: string,
): StepActions {
  const s = () => store.getState();
  const after = (id: string | null) => {
    if (id) focusNode(root(), id);
  };
  return {
    rename: () => ui.getState().startRename(stepId),
    duplicate: () => after(s().duplicateStep(stepId)),
    copyReference() {
      const text = `{{steps.${stepId}}}`;
      const done = () => ui.getState().toast(ui.getState().labels.referenceCopied);
      const failed = () => ui.getState().toast(ui.getState().labels.copyFailed(text));
      try {
        const write = globalThis.navigator?.clipboard?.writeText(text);
        if (write) write.then(done, failed);
        else failed();
      } catch {
        failed();
      }
    },
    replace: () =>
      ui.getState().openPicker({ mode: "replace", stepId }, nodeElement(root(), `step:${stepId}`)),
    toggleDisabled: () => s().toggleDisabled(stepId),
    copy() {
      s().copy(stepId);
      ui.getState().toast(ui.getState().labels.stepCopied);
    },
    pasteAfter: () => after(s().paste(locationAfter(store, stepId))),
    pasteInside: (branch) => after(s().paste({ parentId: stepId, branch, index: 0 })),
    remove() {
      const next = neighbourOf(store, stepId);
      s().removeStep(stepId);
      s().select(next);
      focusNode(root(), next);
      const { labels } = ui.getState();
      ui.getState().toast(labels.stepDeleted, { label: labels.undo, run: () => s().undo() });
    },
  };
}
