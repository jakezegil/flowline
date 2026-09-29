/**
 * State shared by the canvas' nodes, edges and overlays that isn't part of the editor store:
 * the run overlay, the open step picker, inline rename and toasts. Kept in a small
 * per-canvas Zustand store so a card re-renders only when its own slice changes.
 *
 * @module
 */

import type { StepLocation } from "@flowlinejs/core";
import { createContext, useContext } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { FlowlineLabels } from "../labels";
import type { FlowlineNotice, NotifyHandler } from "../provider";
import { notifyHost } from "../ui/toaster";

/** Per-step run state shown on the canvas in run mode. */
export interface RunStepStatus {
  /**
   * `stopped`: the Stop step that ended the run. `cancelled`: the run was cancelled while this
   * step (or a step inside this block) was waiting.
   */
  status:
    | "done"
    | "failed"
    | "running"
    | "waiting"
    | "skipped"
    | "pending"
    | "stopped"
    | "cancelled";
  durationMs?: number;
  attempts?: number;
}

/**
 * Run state painted over a read-only canvas (built by the run viewer from a run's journal).
 * Steps without an entry in `stepStatus` show no status.
 */
export interface RunOverlay {
  /** Status per step ID. */
  stepStatus: Record<string, RunStepStatus>;
  /**
   * IDs of the edges the run took (edge IDs of `layoutTree`, e.g. `"step:cond->step:email"`).
   * Branch edges of a step that ran but aren't in this set are dimmed.
   */
  takenEdges: Set<string>;
  /**
   * The iteration shown per loop step ID, its iteration count, the first failed iteration and
   * every failed iteration (marked in the stepper).
   */
  loopIteration: Record<
    string,
    { index: number; count: number; failedIndex?: number; failedIndices?: number[] }
  >;
  /** Steps the run never reached because their branch wasn't taken; drawn faded, without a badge. */
  dimmedSteps?: Set<string>;
  /** Called by a loop card's iteration stepper. */
  onIterationChange?(stepId: string, index: number): void;
}

/** What the step picker adds or changes. */
export type PickerRequest =
  | { mode: "insert"; loc: StepLocation }
  | { mode: "replace"; stepId: string };

/** A transient notice with an optional action (e.g. "Deleted “Send email” · Undo"). */
export interface Toast {
  id: number;
  message: string;
  /** `edits`: the action edits the doc, so a read-only store hides it. */
  action?: { label: string; run(): void; edits?: boolean };
}

/** The canvas' UI state. */
export interface CanvasUiState {
  /** The UI text (from `<FlowlineProvider labels>`, else English). */
  labels: FlowlineLabels;
  overlay: RunOverlay | undefined;
  /** The open picker and the element it is anchored to. */
  picker: { request: PickerRequest; anchor: HTMLElement | null } | null;
  /** Step whose name is being edited inline. */
  renaming: string | null;
  /**
   * Section (its ID in the doc) whose title is being edited inline: set when a range is grouped
   * into a new section.
   */
  renamingSection: string | null;
  /**
   * The note being edited inline: a step ID, or `"section:<id>"` for a section's note (see
   * {@link sectionNoteKey}).
   */
  editingNote: string | null;
  toasts: Toast[];
  /**
   * A screen-reader-only message in the toast region's live region (e.g. "3 steps selected").
   * `id` changes on every announcement, so a repeated message is read again.
   */
  announcement: { id: number; message: string } | null;
  /** The provider's `onNotify`: takes notices before this canvas shows them. */
  notify: NotifyHandler | undefined;
}

/** Commands that change the canvas' UI state. */
export interface CanvasUiActions {
  openPicker(request: PickerRequest, anchor: HTMLElement | null): void;
  closePicker(): void;
  startRename(stepId: string): void;
  stopRename(): void;
  /** Starts editing a section's title (see {@link CanvasUiState.renamingSection}). */
  startSectionRename(sectionId: string): void;
  stopSectionRename(): void;
  /** Starts editing a note inline (see {@link CanvasUiState.editingNote}). */
  startNoteEdit(key: string): void;
  stopNoteEdit(): void;
  /** Shows a toast for 5 seconds. */
  toast(message: string, action?: Toast["action"]): void;
  dismissToast(id: number): void;
  /** Announces `message` to screen readers only (see {@link CanvasUiState.announcement}). */
  announce(message: string): void;
}

/** A canvas' UI store. */
export type CanvasUiStore = StoreApi<CanvasUiState & CanvasUiActions>;

/** The {@link CanvasUiState.editingNote} key of section `sectionId`'s note. */
export const sectionNoteKey = (sectionId: string): string => `section:${sectionId}`;

/** How long a toast stays up. */
export const TOAST_MS = 5000;

/** Creates the UI store of one canvas. */
export function createCanvasUiStore(init: {
  overlay: RunOverlay | undefined;
  labels: FlowlineLabels;
  notify?: NotifyHandler;
}): CanvasUiStore {
  let nextToast = 1;
  return createStore<CanvasUiState & CanvasUiActions>()((set, get) => ({
    ...init,
    notify: init.notify,
    picker: null,
    renaming: null,
    renamingSection: null,
    editingNote: null,
    toasts: [],
    announcement: null,
    openPicker: (request, anchor) => set({ picker: { request, anchor } }),
    closePicker: () => {
      if (get().picker) set({ picker: null });
    },
    startRename: (stepId) => set({ renaming: stepId }),
    stopRename: () => {
      if (get().renaming !== null) set({ renaming: null });
    },
    startSectionRename: (sectionId) => set({ renamingSection: sectionId }),
    stopSectionRename: () => {
      if (get().renamingSection !== null) set({ renamingSection: null });
    },
    startNoteEdit: (key) => set({ editingNote: key }),
    stopNoteEdit: () => {
      if (get().editingNote !== null) set({ editingNote: null });
    },
    toast(message, action) {
      const notice: FlowlineNotice = {
        message,
        tone: "neutral",
        source: "canvas",
        ...(action ? { action } : {}),
      };
      if (notifyHost(get().notify, notice)) return;
      const id = nextToast++;
      // One toast at a time: a new notice replaces the previous one.
      set({ toasts: [{ id, message, ...(action ? { action } : {}) }] });
      setTimeout(() => get().dismissToast(id), TOAST_MS);
    },
    dismissToast(id) {
      const { toasts } = get();
      if (toasts.some((t) => t.id === id)) set({ toasts: toasts.filter((t) => t.id !== id) });
    },
    announce: (message) => set({ announcement: { id: nextToast++, message } }),
  }));
}

/** The canvas UI store of the enclosing canvas. */
export const CanvasUiContext = createContext<CanvasUiStore | null>(null);

/** The element Radix portals render into (inside `.fl-root`, so theme tokens apply). */
export const PortalContainerContext = createContext<HTMLElement | null>(null);

/** Returns the canvas root element (`.fl-root`), for focusing and anchoring to nodes. */
export const RootElementContext = createContext<() => HTMLElement | null>(() => null);

/** The enclosing canvas' UI store. */
export function useCanvasUiApi(): CanvasUiStore {
  const store = useContext(CanvasUiContext);
  if (!store) throw new Error("Canvas components must be rendered inside <WorkflowCanvas>");
  return store;
}

/** Subscribes to a slice of the canvas UI state. */
export function useCanvasUi<T>(selector: (s: CanvasUiState & CanvasUiActions) => T): T {
  return useStore(useCanvasUiApi(), selector);
}

/** The UI text of the enclosing canvas. */
export function useLabels(): FlowlineLabels {
  return useCanvasUi((s) => s.labels);
}
