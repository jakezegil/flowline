/**
 * The "just changed" highlight. The store's `flash` (set by `apply`, e.g. from an agent bridge)
 * names what a batch changed and carries a `token` that is new on every flash. It can go stale
 * (other edits don't clear it), so a card only flashes for a token it hasn't played yet, never for
 * one set before its canvas mounted, and a removed step simply has no card to flash.
 *
 * @module
 */

import { type AnimationEvent, useEffect, useReducer } from "react";
import { useStore } from "zustand";
import type { EditorStore } from "../store/editor-store";

interface FlashRecord {
  /** Tokens up to this one were set before the canvas mounted: never played. */
  floor: number;
  /** Flash key → the last token played for it. */
  played: Map<string, number>;
  /** Flash key → the token it is (or was last) flashing for, and that flash's phase. */
  phase: Map<string, { token: number; phase: "a" | "b" }>;
}

const records = new WeakMap<EditorStore, FlashRecord>();

function recordOf(store: EditorStore): FlashRecord {
  let r = records.get(store);
  if (!r) {
    r = { floor: store.getState().flash?.token ?? 0, played: new Map(), phase: new Map() };
    records.set(store, r);
  }
  return r;
}

/** How long the flash shows when the user prefers reduced motion (a static ring, no animation). */
export const REDUCED_FLASH_MS = 900;

function prefersReducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
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
 *
 * `flash` is the element's `data-flash` value while it flashes: `"a"` or `"b"`, alternating per
 * token, so a new token that arrives mid-animation changes the animation name and restarts it.
 * Under reduced motion there is no animation to end, so a timer marks the token played.
 *
 * `key` identifies what flashes (default `<kind>:<id>`), for when two elements share an `id`;
 * `gate` (default true) lets such an element opt out of a token.
 */
export function useFlash(
  store: EditorStore,
  kind: "step" | "section",
  id: string,
  options: { key?: string; gate?(token: number): boolean } = {},
): { flashing: boolean; flash: "a" | "b" | undefined; onAnimationEnd(e: AnimationEvent): void } {
  const token = useStore(store, (s) => {
    const f = s.flash;
    if (!f) return 0;
    return (kind === "step" ? f.ids : f.sections).includes(id) ? f.token : 0;
  });
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const r = recordOf(store);
  const key = options.key ?? `${kind}:${id}`;
  const flashing =
    token > r.floor && r.played.get(key) !== token && (options.gate?.(token) ?? true);
  let flash: "a" | "b" | undefined;
  if (flashing) {
    const last = r.phase.get(key);
    if (last?.token !== token) {
      // A new token: the other phase if the last one is still showing, else "a".
      const showing = last !== undefined && r.played.get(key) !== last.token;
      r.phase.set(key, { token, phase: showing && last.phase === "a" ? "b" : "a" });
    }
    flash = r.phase.get(key)?.phase;
  }
  const done = () => {
    r.played.set(key, token);
    rerender();
  };

  useEffect(() => {
    if (!flashing || !prefersReducedMotion()) return;
    const t = setTimeout(() => {
      r.played.set(key, token);
      rerender();
    }, REDUCED_FLASH_MS);
    return () => clearTimeout(t);
  }, [flashing, token, key, r]);

  return {
    flashing,
    flash,
    onAnimationEnd(e) {
      // Only the flash's own end: animations inside the card (and in its portaled tooltips,
      // whose events bubble through React) don't count.
      if (!flashing || e.target !== e.currentTarget) return;
      done();
    },
  };
}
