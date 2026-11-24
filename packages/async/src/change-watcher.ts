import { setImmediate as nextTurn } from 'node:timers/promises';

import { Check } from './check.ts';
import type { WallClock } from './clock.ts';
import { delay } from './delay.ts';
import type { Gauge, Value } from './gauge.ts';
import { milliseconds } from './milliseconds.ts';
import { timeout } from './timeout.ts';
import { untilAborted } from './until-aborted.ts';

// What one check found for one gauge. A failed gauge keeps its last value:
// it changes only when a later read gives another value.
export type Outcome =
  | { readonly state: 'changed' }
  | { readonly state: 'unchanged' }
  | { readonly state: 'failed'; readonly error: unknown };

export interface ChangeWatcherOptions {
  /** Milliseconds to wait after a check, from when the consumer asks for the next check. */
  interval: number;
  /** Milliseconds that the reads of one check can take. A read that takes longer fails for that check. */
  timeout: number;
  /** The clock that the watch runs on: `globalThis` in production, a fake clock in a test. */
  clock: WallClock;
}

// Two values are the same when Object.is says so, member by member for a
// list. Thus NaN is the same as NaN.
function same(a: Value, b: Value): boolean {
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((value, i) => same(value, b[i]));
  return Object.is(a, b);
}

// Settles like the read, or fails when the signal aborts first. A read that
// then rejects within one turn of the event loop fails with its own error,
// which can name what it was doing (ADR 0019). A read that does not reject
// in that turn fails with the reason of the signal.
async function untilRead<V>(read: Promise<V>, signal: AbortSignal): Promise<V> {
  try {
    return await untilAborted(read, signal);
  } catch (error) {
    if (!signal.aborted) throw error;
    throw await Promise.race([
      read.then(
        () => signal.reason,
        (own: unknown) => own,
      ),
      nextTurn(signal.reason),
    ]);
  }
}

/**
 * Checks its gauges again and again. The first check reads at once; each
 * later check waits `interval` from when the consumer asks for it. Each check
 * reads each gauge one time, all at the same time, and yields the outcome of
 * each gauge: changed, unchanged, or failed. At the first check, each gauge
 * that it could read changed. A check with no change still yields. An abort
 * ends the iteration with no error, also while the consumer holds a check or
 * while the reads run.
 */
export class ChangeWatcher<G extends Gauge> {
  readonly #gauges: readonly G[];
  readonly #interval: number;
  readonly #timeout: number;
  readonly #clock: WallClock;

  constructor(gauges: Iterable<G>, options: ChangeWatcherOptions) {
    this.#gauges = [...gauges];
    this.#interval = milliseconds('The interval', options.interval);
    this.#timeout = milliseconds('The timeout', options.timeout);
    this.#clock = options.clock;
  }

  async *watch(
    signal: AbortSignal,
  ): AsyncGenerator<ReadonlyMap<G, Outcome>, void, undefined> {
    const watchStarted = this.#clock.Date.now();
    const last = new Map<G, Value>();
    for (let first = true; ; first = false) {
      if (signal.aborted) return;
      if (!first)
        try {
          await delay(this.#interval, { clock: this.#clock, signal });
        } catch (error) {
          if (signal.aborted) return;
          throw error;
        }
      const outcomes = await this.#check(watchStarted, last, signal);
      if (signal.aborted) return;
      yield outcomes;
    }
  }

  // One check. Its timer ends with the check, before the consumer gets it.
  // The timer keeps the process alive, as the wait between checks does, so a
  // read that never answers fails at the timeout and the watch goes on.
  async #check(
    watchStarted: number,
    last: Map<G, Value>,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<G, Outcome>> {
    using limit = timeout(this.#timeout, { clock: this.#clock, ref: true });
    const check = new Check(
      watchStarted,
      this.#clock.Date.now(),
      AbortSignal.any([signal, limit.signal]),
    );
    // A read that ignores the signal still ends for this check at the timeout,
    // one turn of the event loop after the abort.
    const reads = await Promise.all(
      this.#gauges.map(async (gauge) => {
        try {
          const value = await untilRead(gauge.value(check), check.signal);
          return { gauge, read: true as const, value };
        } catch (error) {
          return { gauge, read: false as const, error };
        }
      }),
    );
    const outcomes = new Map<G, Outcome>();
    for (const result of reads) {
      if (!result.read) {
        outcomes.set(result.gauge, { state: 'failed', error: result.error });
        continue;
      }
      if (
        last.has(result.gauge) &&
        same(last.get(result.gauge), result.value)
      ) {
        outcomes.set(result.gauge, { state: 'unchanged' });
        continue;
      }
      last.set(result.gauge, result.value);
      outcomes.set(result.gauge, { state: 'changed' });
    }
    return outcomes;
  }
}
