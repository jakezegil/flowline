/**
 * Step commands shared by the context menu, the kebab menu and keyboard shortcuts, so each
 * action behaves the same however it is triggered.
 *
 * @module
 */

import {
  branchesFor,
  branchList,
  FlowlineCommandError,
  findStep,
  type Manifest,
  type NodeManifest,
  type Step,
  type StepLocation,
  type WorkflowDoc,
} from "@flowlinejs/core";
import type { FlowlineLabels } from "../labels";
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
  labels: FlowlineLabels,
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
  const before = branchList(parent, loc.branch ?? "")?.[loc.index - 1];
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

/** The list holding `stepId` and its index there, the step that owns it (`null` at the top). */
function siblingsOf(
  doc: WorkflowDoc,
  stepId: string,
): { list: Step[]; index: number; parentId: string | null } | undefined {
  const found = findStep(doc, stepId);
  if (!found) return undefined;
  const { parentId, branch, index } = found.location;
  const owner = found.ancestors[found.ancestors.length - 1]?.step;
  const list = parentId === null ? doc.steps : ((owner && branchList(owner, branch ?? "")) ?? []);
  return { list, index, parentId };
}

/**
 * Where selection goes when the run `first`…`last` (one step by default) is deleted: the next
 * step in its list, else the previous one, else the step that owns the list (or the trigger at
 * the top level).
 */
function neighbourOf(store: EditorStore, first: string, last = first): string {
  const { doc } = store.getState();
  const a = siblingsOf(doc, first);
  if (!a) return TRIGGER_KEY;
  const end = a.list.findIndex((s) => s.id === last);
  const after = end === -1 ? a.index : end;
  return a.list[after + 1]?.id ?? a.list[a.index - 1]?.id ?? a.parentId ?? TRIGGER_KEY;
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
      // Named in the toast, so a Delete on the focused card (not the open one) is plain to see.
      const doomed = findStep(s().doc, stepId)?.step;
      const name = doomed?.name ?? nodeIndex(s().manifest).get(doomed?.type ?? "")?.name ?? stepId;
      const next = neighbourOf(store, stepId);
      const before = s().selection;
      s().removeStep(stepId);
      // The removal cleared a selection inside the deleted subtree: select the neighbour
      // instead. A selection elsewhere (deleting from another card's menu) stays put, and with
      // nothing selected no panel opens; focus goes to the neighbour either way.
      if (before !== null && s().selection === null) s().select(next);
      focusNode(root(), next);
      const { labels } = ui.getState();
      ui.getState().toast(labels.stepDeleted(name), {
        label: labels.undo,
        edits: true,
        // Gone once the store turns read-only (see Toasts); undoing then would throw.
        run: () => {
          if (!s().readOnly) s().undo();
        },
      });
    },
    target() {
      if (s().selection !== null) s().select(stepId);
    },
  };
}

/** A range of the editor store: the run `first`…`last` of one list. */
type Range = { first: string; last: string };

const NO_IDS: ReadonlySet<string> = new Set();
const rangeIdCache = new WeakMap<Range, { doc: WorkflowDoc; ids: ReadonlySet<string> }>();

/**
 * IDs of the steps in `range` (the run's own steps, not their subtrees), cached per range and
 * doc so every card can ask cheaply.
 */
export function rangeIds(doc: WorkflowDoc, range: Range | null): ReadonlySet<string> {
  if (range === null) return NO_IDS;
  const hit = rangeIdCache.get(range);
  if (hit && hit.doc === doc) return hit.ids;
  const a = siblingsOf(doc, range.first);
  const end = a ? a.list.findIndex((s) => s.id === range.last) : -1;
  const ids: ReadonlySet<string> =
    a && end >= a.index ? new Set(a.list.slice(a.index, end + 1).map((s) => s.id)) : NO_IDS;
  rangeIdCache.set(range, { doc, ids });
  return ids;
}

/** The step card holding focus inside `root`, if any. */
function focusedCard(root: HTMLElement | null): string | undefined {
  const active = root?.ownerDocument.activeElement;
  if (!root || !active || !root.contains(active)) return undefined;
  const id = active.closest(".react-flow__node")?.getAttribute("data-id");
  return id?.startsWith("step:") ? id.slice(5) : undefined;
}

/** Whether two steps are in the same list of `doc`. */
function sameListOf(doc: WorkflowDoc, a: string, b: string): boolean {
  const x = siblingsOf(doc, a);
  return x !== undefined && x.list === siblingsOf(doc, b)?.list;
}

/**
 * Shift-click on `clicked`: selects the run from the anchor to it. The anchor is the selected
 * step when it is in the clicked step's list, else the far end of the current range, else the
 * selected step. Returns `false` when there is nothing to extend from (the click is then a plain
 * one). A step in another list is refused with the `rangeOtherList` toast, leaving the selection
 * and the range as they were.
 */
export function shiftSelect(store: EditorStore, ui: CanvasUiStore, clicked: string): boolean {
  const { doc, selection, range } = store.getState();
  const selected =
    selection !== null && selection !== TRIGGER_KEY && findStep(doc, selection)
      ? selection
      : undefined;
  let anchor = selected;
  if (range !== null && (anchor === undefined || !sameListOf(doc, anchor, clicked))) {
    const at = siblingsOf(doc, clicked)?.index ?? 0;
    anchor = at < (siblingsOf(doc, range.first)?.index ?? 0) ? range.last : range.first;
  }
  if (anchor === undefined) return false;
  if (!store.getState().selectRange(anchor, clicked)) {
    ui.getState().toast(ui.getState().labels.rangeOtherList);
  }
  return true;
}

/**
 * ⇧↑/⇧↓ from the card `from`: extends the range to the previous or next step of its list (a
 * block counts as one step), keeping its other end as the anchor, and focuses that step. From a
 * card inside the range (not an end), the range grows from its end in the key's direction. With
 * no range through `from`, starts one there. Nothing happens at the list's edge.
 */
export function extendRange(
  store: EditorStore,
  root: HTMLElement | null,
  from: string,
  delta: -1 | 1,
): void {
  const { doc, range } = store.getState();
  let moving = from;
  let anchor = from;
  if (range !== null && rangeIds(doc, range).has(from)) {
    if (range.first === from && range.last !== from) {
      anchor = range.last;
    } else if (range.last === from && range.first !== from) {
      anchor = range.first;
    } else if (range.first !== from) {
      // Interior: keep the end opposite the key's direction, grow from the other one.
      anchor = delta > 0 ? range.first : range.last;
      moving = delta > 0 ? range.last : range.first;
    }
  }
  const here = siblingsOf(doc, moving);
  const target = here?.list[here.index + delta];
  if (!target) return;
  if (store.getState().selectRange(anchor, target.id)) {
    nodeElement(root, nodeIdOf(target.id))?.focus({ preventScroll: true });
  }
}

/** Focuses the header chip of section `sectionId` once the next layout has rendered. */
function focusSection(root: HTMLElement | null, sectionId: string): void {
  requestAnimationFrame(() => {
    const header = nodeElement(root, `sectionHeader:${sectionId}`);
    (header?.querySelector<HTMLElement>("button") ?? header)?.focus({ preventScroll: true });
  });
}

/** The toast of a failed group: the overlapped section by its shown title, never by ID. */
function groupFailure(doc: WorkflowDoc, err: FlowlineCommandError, labels: FlowlineLabels) {
  const hint = err.error.hint as { section?: unknown } | undefined;
  if (err.error.code !== "section.overlap" || typeof hint?.section !== "string") {
    return labels.groupFailed;
  }
  const section = doc.sections?.find((s) => s.id === hint.section);
  const title = typeof section?.title === "string" ? section.title.trim() : "";
  return labels.sectionOverlap(title || labels.untitledSection);
}

/**
 * Wraps the run `first`…`last` in a new section titled `labels.defaultSectionTitle`, clears the
 * range, focuses the section's header and starts editing its title (`renamingSection`). A run
 * that overlaps a section is refused with a `labels.sectionOverlap` toast, changing nothing.
 */
export function groupSteps(
  store: EditorStore,
  ui: CanvasUiStore,
  root: () => HTMLElement | null,
  first: string,
  last: string,
): void {
  const { labels } = ui.getState();
  let id: string;
  try {
    id = store.getState().addSection(first, last, {
      title: labels.defaultSectionTitle,
      color: "blue",
    });
  } catch (err) {
    if (!(err instanceof FlowlineCommandError)) throw err;
    ui.getState().toast(groupFailure(store.getState().doc, err, labels));
    return;
  }
  // The section now stands for the run; focus goes to it until its title input takes it.
  store.getState().clearRange();
  focusSection(root(), id);
  ui.getState().startSectionRename(id);
}

/**
 * Moves the step `stepId` one place up or down in its list (⌥↑/⌥↓), keeping focus on it; a
 * no-op at the list's edge.
 */
export function moveStepBy(
  store: EditorStore,
  root: () => HTMLElement | null,
  stepId: string,
  delta: -1 | 1,
): void {
  const before = store.getState().doc;
  store.getState().moveBy(stepId, stepId, delta);
  if (store.getState().doc !== before) focusNode(root(), stepId);
}

/** The actions on the store's range (the range toolbar, its right-click menu and range keys). */
export interface RangeActions {
  /** Wraps the range in a new section and starts editing its title (⌘G). */
  group(): void;
  /** Deletes the range as one undo step, with an undo toast. */
  remove(): void;
  /** Copies the range; paste then inserts the whole run (⌘C). */
  copy(): void;
  /** Duplicates the range right after it and moves the range to the copies (⌘D). */
  duplicate(): void;
  /** Moves the range one place up (⌥↑). */
  moveUp(): void;
  /** Moves the range one place down (⌥↓). */
  moveDown(): void;
  /** Clears the range (Esc). */
  clear(): void;
}

/**
 * Binds the actions of the store's current range. `undefined` only without a range. In
 * read-only mode `group`, `remove`, `duplicate`, `moveUp` and `moveDown` are no-ops; `copy` and
 * `clear` work.
 */
export function rangeActions(
  store: EditorStore,
  ui: CanvasUiStore,
  root: () => HTMLElement | null,
): RangeActions | undefined {
  const range = store.getState().range;
  if (range === null) return undefined;
  const { first, last } = range;
  const s = () => store.getState();
  const count = () => rangeIds(s().doc, range).size;
  const edit = (run: () => void) => () => {
    if (!s().readOnly) run();
  };
  const move = (delta: -1 | 1) =>
    edit(() => {
      const focused = focusedCard(root());
      s().moveBy(first, last, delta);
      if (focused) focusNode(root(), focused);
    });
  return {
    group: edit(() => groupSteps(store, ui, root, first, last)),
    remove: edit(() => {
      const n = count();
      const next = neighbourOf(store, first, last);
      const before = s().selection;
      s().removeRange(first, last);
      // As for one step: a selection inside the run moves to the neighbour.
      if (before !== null && s().selection === null) s().select(next);
      focusNode(root(), next);
      const { labels } = ui.getState();
      ui.getState().toast(labels.stepsDeleted(n), {
        label: labels.undo,
        edits: true,
        run: () => {
          if (!s().readOnly) s().undo();
        },
      });
    }),
    copy() {
      const n = count();
      s().copyRange(first, last);
      ui.getState().toast(ui.getState().labels.stepsCopied(n));
    },
    duplicate: edit(() => {
      const n = count();
      const id = s().duplicateRange(first, last);
      const copies = siblingsOf(s().doc, id);
      const end = copies?.list[copies.index + n - 1]?.id;
      if (end !== undefined) s().selectRange(id, end);
      focusNode(root(), id);
    }),
    moveUp: move(-1),
    moveDown: move(1),
    clear() {
      s().clearRange();
      // The Clear button goes away with the range: focus returns to the run.
      focusNode(root(), first);
    },
  };
}
