/**
 * The source of the timers and of the time of a wait. Production gives
 * `globalThis`; a test gives a fake clock, such as `createClock()` of
 * `@sinonjs/fake-timers`, and moves it.
 *
 * The type has only the members that a wait calls. A timer is opaque: the wait
 * keeps it to give it back to `clearTimeout`.
 */
export interface Clock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  performance: { now(): number };
}

/**
 * A clock that also gives the wall time, from `Date.now()`. Production gives
 * `globalThis`; a test gives `createClock()` and sets the wall time with
 * `clock.setSystemTime(time)`. The wall time can jump, so a deadline uses
 * `performance.now()`.
 */
export interface WallClock extends Clock {
  Date: { now(): number };
}
