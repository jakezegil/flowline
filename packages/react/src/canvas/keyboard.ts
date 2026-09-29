/**
 * Canvas keyboard shortcuts. Arrow keys move focus only, from the focused card (else the selected
 * one) in tree order, never nudging cards and never opening a panel; Enter or Space opens (selects)
 * the focused card; shortcuts act on the focused card, whether or not its panel is open.
 * Shortcuts are ignored while typing in inputs, editors and open menus.
 *
 * @module
 */

import { branchList, findStep } from "@flowlinejs/core";
import type { KeyboardEvent } from "react";
import type { LayoutEdge, LayoutNode } from "../layout/layout-tree";
import { type EditorStore, TRIGGER_KEY } from "../store/editor-store";
import { focusNode, locationAfter, nodeElement, nodeIdOf, stepActions } from "./actions";
import type { CanvasUiStore } from "./canvas-context";

/** Whether the platform uses ⌘ (rather than Ctrl) for shortcuts. */
export function isMac(): boolean {
  const nav = globalThis.navigator as
    | (Navigator & { userAgentData?: { platform?: string } })
    | undefined;
  const platform = nav?.userAgentData?.platform ?? nav?.platform ?? "";
  return /mac|iphone|ipad/i.test(platform);
}

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

const ARROWS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

/**
 * Whether a plain key belongs to the focused control (a button, link, tab or menu item other
 * than a canvas node) rather than to the canvas: Enter, Space, Backspace etc. activate or edit
 * it. Arrow keys still move the selection from a plain button such as "+", but not from menu
 * triggers, tabs or menu items, which use them themselves.
 */
function ownsKey(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest('button, a[href], [role="tab"], [role="menuitem"]');
  if (control === null || control.classList.contains("react-flow__node")) return false;
  if (!ARROWS.has(key)) return true;
  return control.hasAttribute("aria-haspopup") || control.getAttribute("role") !== null;
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

/**
 * Whether an event comes from an annotation node (a sticky note, or a section's header on a
 * read-only canvas): focusable, but not a card, so card shortcuts must not fall through to the
 * selection from there.
 */
function onAnnotation(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const id = target.closest(".react-flow__node")?.getAttribute("data-id") ?? "";
  return id.startsWith("note:") || id.startsWith("sectionHeader:");
}

/** Selection keys (step IDs and {@link TRIGGER_KEY}) in pre-order, from the layout's node order. */
export function treeOrder(nodes: LayoutNode[]): string[] {
  const out: string[] = [];
  for (const nd of nodes) {
    if (nd.kind === "trigger") out.push(TRIGGER_KEY);
    else if (nd.kind === "step") out.push(nd.stepId);
  }
  return out;
}

/**
 * The step to move to with ←/→ from `id`: in the neighbouring branch column (skipping empty
 * ones) of the step's parent, the direct child closest in height. `undefined` at the edges or
 * outside branches.
 */
export function siblingColumnStep(
  store: EditorStore,
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  id: string,
  dir: -1 | 1,
): string | undefined {
  const { doc } = store.getState();
  const found = findStep(doc, id);
  if (!found || found.location.parentId === null) return undefined;
  const parent = found.ancestors[found.ancestors.length - 1]?.step;
  if (!parent) return undefined;
  const columns = edges
    .filter((e) => e.kind === "branch" && e.source === `step:${parent.id}`)
    .map((e) => (e.kind === "branch" ? e.branchId : ""));
  const y = new Map<string, number>();
  for (const nd of nodes) if (nd.kind === "step") y.set(nd.stepId, nd.y);
  const here = y.get(id) ?? 0;
  for (
    let i = columns.indexOf(found.location.branch as string) + dir;
    i >= 0 && i < columns.length;
    i += dir
  ) {
    const list = branchList(parent, columns[i] as string) ?? [];
    if (list.length === 0) continue;
    let best = list[0]?.id as string;
    for (const s of list) {
      if (Math.abs((y.get(s.id) ?? 0) - here) < Math.abs((y.get(best) ?? 0) - here)) best = s.id;
    }
    return best;
  }
  return undefined;
}

/** What the keyboard handler needs from the canvas. */
export interface KeyboardDeps {
  store: EditorStore;
  ui: CanvasUiStore;
  root(): HTMLElement | null;
  layout(): { nodes: LayoutNode[]; edges: LayoutEdge[] };
  onStepClick?(id: string): void;
}

/**
 * Handles a keydown on the canvas root. Returns `true` when the key was a canvas shortcut.
 *
 * ↑/↓ focus previous/next in tree order · ←/→ neighbouring branch column · Enter or Space open the
 * focused card · Delete/Backspace delete (with an undo toast) · ⌘Z/⇧⌘Z undo/redo · ⌘C/⌘V
 * copy/paste after · ⌘D duplicate · ⌘K add step after (⇧⌘K before) · F2 rename · Esc deselect. Keys act on the
 * focused card, else the selection. Read-only canvases only navigate.
 */
export function handleCanvasKey(e: KeyboardEvent, deps: KeyboardDeps): boolean {
  if (e.defaultPrevented || isEditableTarget(e.target)) return false;
  const mod = isMac() ? e.metaKey : e.ctrlKey;
  // Plain keys on a focused control ("+", "…", Undo, tabs) belong to that control.
  if (!mod && ownsKey(e.target, e.key)) return false;
  // On a note or section header only navigation keys (↑/↓ from the selection, Esc) and the
  // doc-level undo/redo apply: keys that act on the selected card would act on a card that isn't
  // the one in focus.
  if (onAnnotation(e.target)) {
    const k = e.key.toLowerCase();
    const undoRedo = mod && (k === "z" || (k === "y" && !isMac()));
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown" && e.key !== "Escape" && !undoRedo) {
      return false;
    }
  }
  const { store, ui } = deps;
  const state = store.getState();
  const { readOnly } = state;
  // The card keys act on: the focused one (panel open or not), else the selected one.
  const active = deps.root()?.ownerDocument.activeElement ?? null;
  const selection =
    focusedKey(e.target) ??
    (deps.root()?.contains(active) ? focusedKey(active) : undefined) ??
    state.selection;
  const key = e.key.length === 1 && e.key !== " " ? e.key.toLowerCase() : e.key;
  const stepSelected = selection !== null && selection !== TRIGGER_KEY;
  /** Arrow keys: focus moves, the selection (and its open panel) stays; Enter opens. */
  const moveTo = (id: string | undefined) => {
    if (id === undefined) return;
    nodeElement(deps.root(), nodeIdOf(id))?.focus({ preventScroll: true });
  };

  if (!mod && !e.altKey && (key === "ArrowUp" || key === "ArrowDown")) {
    const order = treeOrder(deps.layout().nodes);
    const at = selection === null ? -1 : order.indexOf(selection);
    const next = at === -1 ? 0 : at + (key === "ArrowDown" ? 1 : -1);
    moveTo(order[Math.max(0, Math.min(order.length - 1, next))]);
    return true;
  }
  if (!mod && !e.altKey && (key === "ArrowLeft" || key === "ArrowRight")) {
    if (!stepSelected) return false;
    const { nodes, edges } = deps.layout();
    moveTo(siblingColumnStep(store, nodes, edges, selection, key === "ArrowLeft" ? -1 : 1));
    return true;
  }
  if ((key === "Enter" || key === " ") && !mod && selection !== null) {
    state.select(selection);
    deps.onStepClick?.(selection);
    return true;
  }
  if (key === "Escape" && state.selection !== null) {
    state.select(null);
    return true;
  }
  if (readOnly) return false;

  const actions = stepSelected ? stepActions(store, ui, deps.root, selection) : undefined;
  if ((key === "Delete" || key === "Backspace") && !mod && actions) {
    actions.remove();
    return true;
  }
  if (key === "F2" && actions) {
    actions.rename();
    return true;
  }
  if (!mod) return false;
  if (key === "z" || (key === "y" && !isMac())) {
    if (key === "z" && !e.shiftKey) state.undo();
    else state.redo();
    return true;
  }
  if (key === "c" && actions && !e.shiftKey) {
    actions.copy();
    return true;
  }
  if (key === "v" && !e.shiftKey && state.clipboard) {
    const id = state.paste(locationAfter(store, selection));
    if (id) focusNode(deps.root(), id);
    return true;
  }
  if (key === "d" && actions) {
    actions.duplicate();
    return true;
  }
  if (key === "k") {
    const anchor = selection ? nodeElement(deps.root(), nodeIdOf(selection)) : null;
    // ⇧⌘K adds before the focused step (the only way to the top of a branch from the keyboard).
    const at = e.shiftKey && stepSelected ? findStep(state.doc, selection)?.location : undefined;
    ui.getState().openPicker(
      { mode: "insert", loc: at ?? locationAfter(store, selection) },
      anchor,
    );
    return true;
  }
  return false;
}
