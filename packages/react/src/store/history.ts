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

/** Undo/redo stacks of snapshots of type `T`. */
export interface History<T> {
  /** Older snapshots, oldest first. */
  past: T[];
  /** Undone snapshots, next redo last. */
  future: T[];
  /** The coalesce key and time of the most recent recorded edit, if it had a key. */
  last?: { key: string; at: number };
}

/** An empty history. */
export function emptyHistory<T>(): History<T> {
  return { past: [], future: [] };
}

/**
 * Records an edit that replaced `previous`. When `key` equals the previous edit's key and less
 * than {@link COALESCE_MS} passed since it, the edit joins that undo step (the older snapshot is
 * kept, so one undo reverts the whole burst). Always clears the redo stack.
 */
export function recordEdit<T>(
  h: History<T>,
  previous: T,
  key: string | undefined,
  at: number,
): History<T> {
  const last = key === undefined ? undefined : { key, at };
  if (key !== undefined && h.last?.key === key && at - h.last.at < COALESCE_MS) {
    return { past: h.past, future: [], last };
  }
  const past = [...h.past, previous];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return last ? { past, future: [], last } : { past, future: [] };
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
