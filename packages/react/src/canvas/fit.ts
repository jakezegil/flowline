/**
 * Where the canvas opens: fit to view, clamped to a readable zoom and anchored to the top
 * (docs/research/canvas-ux.md: "clamp zoom, pad ~100px, anchor to top").
 *
 * @module
 */

/** Top padding (and side padding, space permitting) of the fit. */
export const FIT_PADDING = 100;
/**
 * The initial fit never zooms out further than this: step cards stay readable, and a big
 * workflow opens at its top (the rest is a pan away) rather than shrunk to fit.
 */
export const FIT_MIN_ZOOM = 0.85;
/** The initial fit never zooms in past 100%. */
export const FIT_MAX_ZOOM = 1;

/**
 * The viewport that fits a laid-out tree (`width` × `height`, the trigger centered at x = 0,
 * y = 0 at its top) into a `paneW` × `paneH` pane: horizontally centered on the trigger, its top
 * `FIT_PADDING` below the pane's top (less on small panes). The zoom fits the tree, clamped to
 * [{@link FIT_MIN_ZOOM}, 1]; `whole` (the "Fit" button) lowers the floor to `minZoom` so the
 * entire tree shows.
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
  const floor = opts.whole ? opts.minZoom : FIT_MIN_ZOOM;
  const zoom = Math.min(FIT_MAX_ZOOM, Math.max(floor, Math.min(byWidth, byHeight)));
  return { x: pane.width / 2, y: padTop, zoom };
}
