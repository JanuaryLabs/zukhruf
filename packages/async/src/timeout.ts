import type { Clock } from './clock.ts';
import { delay } from './delay.ts';

export interface TimeoutOptions {
  /** The clock that the timer runs on: `globalThis` in production, a fake clock in a test. */
  clock: Clock;
}

/** A signal that aborts after a time on a clock. A disposal stops its timer. */
export interface Timeout extends Disposable {
  /** Aborts after the time, with a `DOMException` whose name is `TimeoutError`. */
  readonly signal: AbortSignal;
}

/**
 * Gives a signal that aborts after `ms` milliseconds on the clock, as
 * `AbortSignal.timeout` does on the real clock. Dispose the timeout when the
 * wait ends: `using limit = timeout(ms, { clock })`. The time runs on `delay`,
 * so a timeout longer than one timer can hold lasts the full time.
 */
export function timeout(ms: number, { clock }: TimeoutOptions): Timeout {
  const controller = new AbortController();
  const disposal = new AbortController();
  delay(ms, { clock, signal: disposal.signal }).then(
    () =>
      controller.abort(
        new DOMException(
          'The operation was aborted due to timeout',
          'TimeoutError',
        ),
      ),
    // The disposal stopped the wait: the signal never aborts.
    () => {},
  );
  return {
    signal: controller.signal,
    [Symbol.dispose]: () => disposal.abort(),
  };
}
