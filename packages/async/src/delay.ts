import { addAbortListener } from 'node:events';

import type { Clock } from './clock.ts';
import { untilAborted } from './until-aborted.ts';

export interface DelayOptions {
  /** The clock that the wait runs on: `globalThis` in production, a fake clock in a test. */
  clock: Clock;
  /** Stops the wait: the timer stops, and the delay rejects with `signal.reason`. */
  signal: AbortSignal | undefined;
  /**
   * With `false`, the wait does not keep the process alive: `delay` calls
   * `unref()` on the timer of the clock, when the timer has one. Without it,
   * the timer keeps its default.
   */
  ref?: boolean | undefined;
}

// The longest delay that one timer holds, about 24.8 days. Node.js fires a
// timer with a longer delay after 1 ms, and so does createClock().
const TIMER_MAX = 2 ** 31 - 1;

/**
 * Waits `ms` milliseconds on the clock. When the signal aborts, also before
 * the call, the timer stops and the delay rejects with the reason of the
 * signal. No listener stays on the signal after the delay settles.
 *
 * A wait longer than one timer can hold runs as a chain of timers of at most
 * 2^31-1 ms, so it lasts the full time. Each next timer gets the time that is
 * left on `clock.performance.now()`, so a late timer does not make the wait
 * longer.
 */
export async function delay(ms: number, options: DelayOptions): Promise<void> {
  const end = options.clock.performance.now() + ms;
  let left = ms;
  while (left > TIMER_MAX) {
    await wait(TIMER_MAX, options);
    left = end - options.clock.performance.now();
  }
  await wait(left, options);
}

// One timer.
function wait(ms: number, { clock, signal, ref }: DelayOptions): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = clock.setTimeout(resolve, ms);
  if (ref === false) unref(timer);
  if (!signal) return promise;
  // Also runs when the signal aborted before the call.
  const listening = addAbortListener(signal, () => clock.clearTimeout(timer));
  return untilAborted(promise, signal).finally(() =>
    listening[Symbol.dispose](),
  );
}

function unref(timer: unknown): void {
  if (
    typeof timer === 'object' &&
    timer !== null &&
    'unref' in timer &&
    typeof timer.unref === 'function'
  ) {
    timer.unref();
  }
}
