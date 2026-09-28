import { afterEach, describe, expect, test, vi } from "vitest";
import { FIT_MIN_ZOOM, FIT_PADDING, fitViewport, motionDuration, revealViewport } from "./fit";

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

describe("revealViewport", () => {
  const card = (x: number, y: number) => ({ x, y, w: 280, h: 72 });
  const pane = { width: 800, height: 600 };

  test("a card already in view doesn't move", () => {
    expect(revealViewport(pane, [0, 0, 1], card(100, 100), [], 24)).toBeNull();
  });

  test("a card cut off by a narrowed pane pans just far enough, keeping zoom", () => {
    // Its right edge is at 900 in an 800px pane: move left by 900 - (800 - 24).
    expect(revealViewport(pane, [0, 0, 1], card(620, 100), [], 24)).toEqual({
      x: -124,
      y: 0,
      zoom: 1,
    });
    // Off the top and left: moves right and down, at the current zoom.
    expect(revealViewport(pane, [-200, -100, 0.5], card(100, 100), [], 24)).toEqual({
      x: -26,
      y: -26,
      zoom: 0.5,
    });
  });

  test("branch heads come along when they fit, else only the card is kept in view", () => {
    const heads = [card(-300, 250), card(300, 250)];
    // The group spans -300..580; at zoom 1 it fits an 1000px pane.
    const wide = { width: 1000, height: 600 };
    expect(revealViewport(wide, [0, 0, 1], card(0, 100), heads, 24)).toEqual({
      x: 324,
      y: 0,
      zoom: 1,
    });
    // In an 800px pane it doesn't fit: the card alone is in view, so nothing moves.
    expect(revealViewport(pane, [0, 0, 1], card(100, 100), heads, 24)).toBeNull();
  });
});

describe("motionDuration", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("animates normally, and jumps when the user prefers reduced motion", () => {
    const media = (reduce: boolean) => (q: string) => ({ matches: reduce && q.includes("reduce") });
    vi.stubGlobal("matchMedia", media(false));
    expect(motionDuration(250)).toBe(250);
    vi.stubGlobal("matchMedia", media(true));
    expect(motionDuration(250)).toBe(0);
  });
});
