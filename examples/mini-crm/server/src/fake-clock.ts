/**
 * A demo clock that can be moved forward, so "three days later" takes one request instead of
 * three days. The server uses it when started with `MINI_CRM_FAKE_CLOCK=1`.
 *
 * @module
 */

/** A clock that runs with real time plus an offset that each advance grows. */
export interface FakeClock {
  /** The current time in epoch ms: real time plus every advance so far. */
  now(): number;
  /** Move the clock forward by `ms` (a positive whole number). */
  advance(ms: number): void;
  /** Go back to real time (offset 0). */
  reset(): void;
}

/**
 * Create a {@link FakeClock}. It starts at real time and keeps ticking with it, so leases,
 * timers and relative times behave normally between advances.
 *
 * @param realNow - The real time source. Default `Date.now`.
 */
export function createFakeClock(realNow: () => number = Date.now): FakeClock {
  let offset = 0;
  return {
    now: () => realNow() + offset,
    advance(ms) {
      if (!(Number.isInteger(ms) && ms > 0)) {
        throw new RangeError("advance needs a positive whole number of ms");
      }
      offset += ms;
    },
    reset() {
      offset = 0;
    },
  };
}
