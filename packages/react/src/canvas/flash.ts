/**
 * The "just changed" highlight. The store's `flash` (set by `apply`, e.g. from an agent bridge)
 * names what a batch changed and carries a `token` that is new on every flash. It can go stale
 * (other edits don't clear it), so a card only flashes for a token it hasn't played yet, never for
 * one set before its canvas mounted, and a removed step simply has no card to flash.
 *
 * @module
 */

import { type AnimationEvent, useReducer } from "react";
import { useStore } from "zustand";
import type { EditorStore } from "../store/editor-store";

interface FlashRecord {
  /** Tokens up to this one were set before the canvas mounted: never played. */
  floor: number;
  /** `"step:<id>"` / `"section:<id>"` → the last token played for it. */
  played: Map<string, number>;
}

const records = new WeakMap<EditorStore, FlashRecord>();

function recordOf(store: EditorStore): FlashRecord {
  let r = records.get(store);
  if (!r) {
    r = { floor: store.getState().flash?.token ?? 0, played: new Map() };
    records.set(store, r);
  }
  return r;
}

/**
 * Marks the store's current flash as already seen, so a canvas mounting now doesn't replay it.
 * Called once per canvas mount.
 */
export function settleFlash(store: EditorStore): void {
  const r = recordOf(store);
  r.floor = Math.max(r.floor, store.getState().flash?.token ?? 0);
}

/**
 * Whether the step (or section) `id` should show the flash now, and the `animationend` handler
 * (for the flashing element itself) that marks it played.
 */
export function useFlash(
  store: EditorStore,
  kind: "step" | "section",
  id: string,
): { flashing: boolean; onAnimationEnd(e: AnimationEvent): void } {
  const token = useStore(store, (s) => {
    const f = s.flash;
    if (!f) return 0;
    return (kind === "step" ? f.ids : f.sections).includes(id) ? f.token : 0;
  });
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const r = recordOf(store);
  const key = `${kind}:${id}`;
  const flashing = token > r.floor && r.played.get(key) !== token;
  return {
    flashing,
    onAnimationEnd(e) {
      // Only the flash's own end: animations inside the card (and in its portaled tooltips,
      // whose events bubble through React) don't count.
      if (!flashing || e.target !== e.currentTarget) return;
      r.played.set(key, token);
      rerender();
    },
  };
}
