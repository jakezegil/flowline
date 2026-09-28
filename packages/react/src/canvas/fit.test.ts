import { describe, expect, test } from "vitest";
import { FIT_MIN_ZOOM, FIT_PADDING, fitViewport } from "./fit";

const pane = { width: 1200, height: 800 };

describe("fitViewport", () => {
  test("a small workflow opens at 100%, centered on the trigger and anchored to the top", () => {
    expect(fitViewport(pane, { width: 300, height: 400 }, { minZoom: 0.25 })).toEqual({
      x: 600,
      y: FIT_PADDING,
      zoom: 1,
    });
  });

  test("a large tree opens at the readable floor instead of shrinking to fit", () => {
    // Fitting this one entirely would need about 0.6.
    const big = { width: 1700, height: 1200 };
    const v = fitViewport(pane, big, { minZoom: 0.25 });
    expect(FIT_MIN_ZOOM).toBeGreaterThanOrEqual(0.85);
    expect(v.zoom).toBe(FIT_MIN_ZOOM);
    // Still anchored to the top: the trigger sits at the top padding, not the tree's middle.
    expect(v.y).toBe(FIT_PADDING);
    expect(v.x).toBe(600);
  });

  test("zooms between the floor and 100% when that fits the tree", () => {
    // Height decides: (800 - 100 top - 75 bottom) / 690.
    const v = fitViewport(pane, { width: 1000, height: 690 }, { minZoom: 0.25 });
    expect(v.zoom).toBeCloseTo(625 / 690, 5);
  });

  test("`whole` (the Fit button) fits everything, down to minZoom", () => {
    const big = { width: 1700, height: 1200 };
    expect(fitViewport(pane, big, { whole: true, minZoom: 0.25 }).zoom).toBeCloseTo(625 / 1200, 5);
    const huge = { width: 20_000, height: 20_000 };
    expect(fitViewport(pane, huge, { whole: true, minZoom: 0.25 }).zoom).toBe(0.25);
  });

  test("small panes shrink the padding", () => {
    expect(
      fitViewport({ width: 320, height: 400 }, { width: 100, height: 100 }, { minZoom: 0.25 }),
    ).toMatchObject({ x: 160, y: 50 });
  });
});
