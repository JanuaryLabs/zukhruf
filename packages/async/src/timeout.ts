import type { Clock } from './clock.ts';
import { TIMER_MAX } from './delay.ts';

export interface TimeoutOptions {
  /** The clock that the timer runs on: `globalThis` in production, a fake clock in a test. */
  clock: Clock;
}

/** A signal that aborts after a time on a clock. A disposal stops its timer. */
export interface Timeout extends Disposable {
  /** Aborts after the time, with a `DOMException` whose name is `TimeoutError`. */
  readonly signal: AbortSignal;
}

// The number of parts in which a timeout counts its time. A timer of Node.js
// on macOS counts the time of a system sleep, so a timer that was running
// when the computer slept fires at the wake. Each part is one timer, and a
// part that ends late uses up only its own length: a sleep, or a process that
// the system stopped, takes at most one part from the work that the timeout
// limits.
const PARTS = 10;

/**
 * Gives a signal that aborts after `ms` milliseconds on the clock, as
 * `AbortSignal.timeout` does on the real clock. Dispose the timeout when the
 * wait ends: `using limit = timeout(ms, { clock })`. The time runs in parts
 * of at most one timer each, so a timeout longer than one timer can hold
 * lasts the full time, and the time of a system sleep does not use it up.
 */
export function timeout(ms: number, { clock }: TimeoutOptions): Timeout {
  const controller = new AbortController();
  const part = Math.min(Math.max(Math.ceil(ms / PARTS), 1), TIMER_MAX);
  let timer: unknown;
  const count = (left: number): void => {
    timer = clock.setTimeout(
      () => {
        if (left > part) {
          count(left - part);
          return;
        }
        controller.abort(
          new DOMException(
            'The operation was aborted due to timeout',
            'TimeoutError',
          ),
        );
      },
      Math.min(left, part),
    );
  };
  count(ms);
  return {
    signal: controller.signal,
    [Symbol.dispose]: () => clock.clearTimeout(timer),
  };
}
