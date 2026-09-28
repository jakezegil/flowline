/**
 * Step commands shared by the context menu, the kebab menu and keyboard shortcuts, so each
 * action behaves the same however it is triggered.
 *
 * @module
 */

import {
  branchesFor,
  findStep,
  type Manifest,
  type NodeManifest,
  type Step,
  type StepLocation,
  type WorkflowDoc,
} from "@flowkit/core";
import type { FlowkitLabels } from "../labels";
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

const stepIndexes = new WeakMap<WorkflowDoc, Map<string, Step>>();
const nodeIndexes = new WeakMap<Manifest, Map<string, NodeManifest>>();

/** Every step of `doc` by ID, built once per doc (every "+" of the canvas asks). */
function stepIndex(doc: WorkflowDoc): Map<string, Step> {
  let index = stepIndexes.get(doc);
  if (!index) {
    const built = new Map<string, Step>();
    const walk = (list: Step[]) => {
      for (const step of list) {
        built.set(step.id, step);
        for (const branch of Object.values(step.branches ?? {})) walk(branch);
      }
    };
    walk(doc.steps);
    index = built;
    stepIndexes.set(doc, index);
  }
  return index;
}

/** The manifest's nodes by type, built once per manifest. */
function nodeIndex(manifest: Manifest): Map<string, NodeManifest> {
  let index = nodeIndexes.get(manifest);
  if (!index) {
    index = new Map(manifest.nodes.map((n) => [n.type, n]));
    nodeIndexes.set(manifest, index);
  }
  return index;
}

/**
 * The accessible name of a "+" (or empty-branch placeholder) inserting at `loc`: after the step
 * before it, else at the top of its branch, else under the trigger. Lookups go through indexes
 * built once per doc and manifest, so labelling every "+" stays linear in the workflow's size.
 */
export function insertLabel(
  doc: WorkflowDoc,
  manifest: Manifest,
  loc: StepLocation,
  labels: FlowkitLabels,
): string {
  const steps = stepIndex(doc);
  const nodes = nodeIndex(manifest);
  const nameOf = (id: string) => {
    const step = steps.get(id);
    if (!step) return id;
    return step.name ?? nodes.get(step.type)?.name ?? step.id;
  };
  if (loc.parentId === null) {
    const before = doc.steps[loc.index - 1];
    return before
      ? labels.addStepAfter(nameOf(before.id))
      : labels.addStepAfterTrigger(doc.steps.length === 0);
  }
  const parent = steps.get(loc.parentId);
  if (!parent) return labels.addStepHere;
  const before = parent.branches?.[loc.branch ?? ""]?.[loc.index - 1];
  if (before) return labels.addStepAfter(nameOf(before.id));
  const m = nodes.get(parent.type);
  const branch =
    m?.branches.kind === "loop"
      ? labels.eachItem
      : ((m && branchesFor(m, parent).find((b) => b.id === loc.branch)?.label) ?? loc.branch ?? "");
  return labels.addStepInBranch(branch, nameOf(parent.id));
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
  /**
   * Makes this step the target of its right-click menu: when a panel is open (another step is
   * selected) it moves to this step, so the menu never acts on one step while showing another.
   */
  target(): void;
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
    // The copy takes the panel when one is open; with none open, it only takes focus.
    duplicate: () => after(s().duplicateStep(stepId, { select: s().selection !== null })),
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
      const before = s().selection;
      s().removeStep(stepId);
      // The removal cleared a selection inside the deleted subtree: select the neighbour
      // instead. A selection elsewhere (deleting from another card's menu) stays put, and with
      // nothing selected no panel opens; focus goes to the neighbour either way.
      if (before !== null && s().selection === null) s().select(next);
      focusNode(root(), next);
      const { labels } = ui.getState();
      ui.getState().toast(labels.stepDeleted, { label: labels.undo, run: () => s().undo() });
    },
    target() {
      if (s().selection !== null) s().select(stepId);
    },
  };
}
