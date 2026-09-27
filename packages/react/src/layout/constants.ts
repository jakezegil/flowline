/**
 * Fixed sizes (in canvas pixels) of the deterministic tree layout. Cards have a fixed size so
 * branch math stays simple and positions are stable across edits.
 *
 * @module
 */

/** Width of a trigger/step card. */
export const CARD_W = 260;
/** Height of a trigger/step card. */
export const CARD_H = 72;
/** Vertical gap between consecutive nodes in a column; room for the "+" button on the edge. */
export const V_GAP = 56;
/** Horizontal gap between sibling branch columns. */
export const BRANCH_GAP = 48;
/** Side length of the square rejoin node below a block (also used for the `end` node). */
export const JOIN_SIZE = 12;
/** Height of the dashed "Add step" placeholder shown in an empty branch. */
export const PLACEHOLDER_H = 44;
/** Extra vertical space above each branch column for its label pill. */
export const LABEL_H = 24;
/**
 * Horizontal margin on each side of a loop's body column, reserved for routing the
 * `loopReturn` edge so it never crosses a neighbouring column.
 */
export const LOOP_GUTTER = BRANCH_GAP / 2;
