/**
 * Where the canvas opens: fit to view, clamped to a readable zoom and anchored to the top
 * (docs/research/canvas-ux.md: "clamp zoom, pad ~100px, anchor to top").
 *
 * @module
 */

/**
 * `ms`, or `0` when the user prefers reduced motion: viewport moves the user didn't drag (reveal,
 * fit, zoom buttons) then jump instead of animating.
 */
export function motionDuration(ms: number): number {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : ms;
  } catch {
    return ms;
  }
}

/** Top padding (and side padding, space permitting) of the fit. */
export const FIT_PADDING = 100;
/**
 * The initial fit never zooms out further than this: step cards stay readable, and a big
 * workflow opens at its top (the rest is a pan away) rather than shrunk to fit.
 */
export const FIT_MIN_ZOOM = 0.85;
/**
 * The Fit button never zooms out further than this: a very large workflow fits as far as it can
 * while cards stay legible, anchored to the top, and the rest is a scroll away (M12).
 */
export const FIT_WHOLE_MIN_ZOOM = 0.5;
/** The initial fit never zooms in past 100%. */
export const FIT_MAX_ZOOM = 1;

/**
 * The viewport that fits a laid-out tree (`width` × `height`, the trigger centered at x = 0,
 * y = 0 at its top) into a `paneW` × `paneH` pane: horizontally centered on the trigger, its top
 * `FIT_PADDING` below the pane's top (less on small panes). The zoom fits the tree, clamped to
 * [{@link FIT_MIN_ZOOM}, 1]; `whole` (the "Fit" button) lowers the floor so the entire tree
 * shows, but never below {@link FIT_WHOLE_MIN_ZOOM} (or `minZoom`, if higher): past that it
 * stays anchored to the top and the rest pans.
 */
export function fitViewport(
  pane: { width: number; height: number },
  tree: { width: number; height: number },
  opts: { whole?: boolean; minZoom: number },
): { x: number; y: number; zoom: number } {
  const padX = Math.min(FIT_PADDING, pane.width / 16);
  const padTop = Math.min(FIT_PADDING, pane.height / 8);
  const byWidth = (pane.width - 2 * padX) / Math.max(tree.width, 1);
  const byHeight = (pane.height - padTop - padX) / Math.max(tree.height, 1);
  const floor = opts.whole ? Math.max(opts.minZoom, FIT_WHOLE_MIN_ZOOM) : FIT_MIN_ZOOM;
  const zoom = Math.min(FIT_MAX_ZOOM, Math.max(floor, Math.min(byWidth, byHeight)));
  return { x: pane.width / 2, y: padTop, zoom };
}

/** A rectangle in canvas coordinates. */
export interface CanvasRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The smallest pan (zoom unchanged) that brings `focus` at least `margin` px inside the pane, and
 * `context` too where it fits along that axis (a block's branch heads below it). Each axis moves
 * independently, only as far as needed; `null` when nothing needs to move.
 *
 * @param transform xyflow's `[x, y, zoom]`.
 */
export function revealViewport(
  pane: { width: number; height: number },
  transform: readonly [number, number, number],
  focus: CanvasRect,
  context: readonly CanvasRect[],
  margin: number,
): { x: number; y: number; zoom: number } | null {
  const [tx, ty, zoom] = transform;
  const axis = (
    t: number,
    size: number,
    pos: (r: CanvasRect) => number,
    len: (r: CanvasRect) => number,
  ): number => {
    const lo = Math.min(pos(focus), ...context.map(pos));
    const hi = Math.max(pos(focus) + len(focus), ...context.map((r) => pos(r) + len(r)));
    // The whole group when it fits, else just the focused card.
    const fits = (hi - lo) * zoom <= size - 2 * margin;
    const from = (fits ? lo : pos(focus)) * zoom + t;
    const to = (fits ? hi : pos(focus) + len(focus)) * zoom + t;
    if (from < margin) return t + (margin - from);
    if (to > size - margin) return t - Math.min(to - (size - margin), from - margin);
    return t;
  };
  const x = axis(
    tx,
    pane.width,
    (r) => r.x,
    (r) => r.w,
  );
  const y = axis(
    ty,
    pane.height,
    (r) => r.y,
    (r) => r.h,
  );
  return x === tx && y === ty ? null : { x, y, zoom };
}
