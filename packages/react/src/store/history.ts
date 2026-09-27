/**
 * Undo/redo history of immutable snapshots. Snapshots share most of their structure (the core
 * tree operations never mutate and reuse untouched steps), so keeping 100 of them is cheap.
 *
 * @module
 */

/** Maximum number of undo steps kept; the oldest are dropped first. */
export const HISTORY_LIMIT = 100;

/** Edits with the same coalesce key closer together than this (ms) form a single undo step. */
export const COALESCE_MS = 500;

/** A coalesced burst never spans more than this (ms) from its first edit, so long typing sessions still get intermediate undo steps. */
export const COALESCE_MAX_MS = 2000;

/** Undo/redo stacks of snapshots of type `T`. */
export interface History<T> {
  /** Older snapshots, oldest first. */
  past: T[];
  /** Undone snapshots, next redo last. */
  future: T[];
  /**
   * The coalesce key and time of the most recent recorded edit, if it had a key, and when its
   * burst started.
   */
  last?: { key: string; at: number; start: number };
}

/** An empty history. */
export function emptyHistory<T>(): History<T> {
  return { past: [], future: [] };
}

/**
 * Records an edit that replaced `previous`. When `key` equals the previous edit's key, less than
 * {@link COALESCE_MS} passed since it and less than {@link COALESCE_MAX_MS} since the burst's
 * first edit, the edit joins that undo step (the older snapshot is kept, so one undo reverts the
 * whole burst). Always clears the redo stack.
 */
export function recordEdit<T>(
  h: History<T>,
  previous: T,
  key: string | undefined,
  at: number,
): History<T> {
  const prev = h.last;
  if (
    key !== undefined &&
    prev?.key === key &&
    at - prev.at < COALESCE_MS &&
    at - prev.start < COALESCE_MAX_MS
  ) {
    return { past: h.past, future: [], last: { key, at, start: prev.start } };
  }
  const past = [...h.past, previous];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return key === undefined
    ? { past, future: [] }
    : { past, future: [], last: { key, at, start: at } };
}

/** Steps back from `current`, or returns `undefined` when there is nothing to undo. */
export function undoEdit<T>(
  h: History<T>,
  current: T,
): { history: History<T>; value: T } | undefined {
  if (h.past.length === 0) return undefined;
  const value = h.past[h.past.length - 1] as T;
  return { history: { past: h.past.slice(0, -1), future: [...h.future, current] }, value };
}

/** Re-applies the last undone snapshot, or returns `undefined` when there is nothing to redo. */
export function redoEdit<T>(
  h: History<T>,
  current: T,
): { history: History<T>; value: T } | undefined {
  if (h.future.length === 0) return undefined;
  const value = h.future[h.future.length - 1] as T;
  return { history: { past: [...h.past, current], future: h.future.slice(0, -1) }, value };
}
