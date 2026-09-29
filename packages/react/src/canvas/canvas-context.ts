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
  action?: { label: string; run(): void };
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
  toasts: Toast[];
  /** The provider's `onNotify`: takes notices before this canvas shows them. */
  notify: NotifyHandler | undefined;
}

/** Commands that change the canvas' UI state. */
export interface CanvasUiActions {
  openPicker(request: PickerRequest, anchor: HTMLElement | null): void;
  closePicker(): void;
  startRename(stepId: string): void;
  stopRename(): void;
  /** Shows a toast for 5 seconds. */
  toast(message: string, action?: Toast["action"]): void;
  dismissToast(id: number): void;
}

/** A canvas' UI store. */
export type CanvasUiStore = StoreApi<CanvasUiState & CanvasUiActions>;

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
    toasts: [],
    openPicker: (request, anchor) => set({ picker: { request, anchor } }),
    closePicker: () => {
      if (get().picker) set({ picker: null });
    },
    startRename: (stepId) => set({ renaming: stepId }),
    stopRename: () => {
      if (get().renaming !== null) set({ renaming: null });
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
