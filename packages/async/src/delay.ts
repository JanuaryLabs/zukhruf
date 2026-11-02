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

/**
 * Waits `ms` milliseconds on the clock. When the signal aborts, also before
 * the call, the timer stops and the delay rejects with the reason of the
 * signal. No listener stays on the signal after the delay settles.
 */
export function delay(
  ms: number,
  { clock, signal, ref }: DelayOptions,
): Promise<void> {
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
