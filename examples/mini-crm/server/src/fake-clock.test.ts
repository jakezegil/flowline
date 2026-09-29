import { describe, expect, it } from "vitest";
import { createFakeClock } from "./fake-clock";

describe("createFakeClock", () => {
  it("runs with real time, moves forward on advance and back on reset", () => {
    let real = 1_000;
    const clock = createFakeClock(() => real);
    expect(clock.now()).toBe(1_000);
    clock.advance(500);
    clock.advance(250);
    real += 10;
    expect(clock.now()).toBe(1_760);
    clock.reset();
    expect(clock.now()).toBe(1_010);
  });

  it("only advances by a positive whole number of ms", () => {
    const clock = createFakeClock(() => 0);
    for (const ms of [0, -1, 1.5, Number.NaN]) {
      expect(() => clock.advance(ms)).toThrow(RangeError);
    }
    expect(clock.now()).toBe(0);
  });
});
