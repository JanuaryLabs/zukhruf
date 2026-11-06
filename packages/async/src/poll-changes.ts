import type { Clock } from './clock.ts';
import { delay } from './delay.ts';

export interface PollChangesOptions {
  /** Milliseconds to wait after a check, from when the consumer asks for the next check. */
  interval: number;
  /** Stops the wait between two checks. The iteration then ends with no error. */
  signal: AbortSignal;
  /** The clock that the wait runs on: `globalThis` in production, a fake clock in a test. */
  clock: Clock;
}

/**
 * Calls `read` at once, and yields all the keys it gave. Then, after each
 * `interval`, calls `read` again and yields the keys whose value is not `===`
 * to the value of the previous check, and the keys that only one of the two
 * checks gave: an empty set when nothing changed. One call of `read` gives
 * the values of all keys of a check. An error from `read` rejects the
 * iteration unchanged.
 */
export async function* pollChanges<K>(
  read: () => Promise<ReadonlyMap<K, unknown>>,
  { interval, signal, clock }: PollChangesOptions,
): AsyncGenerator<ReadonlySet<K>, void, undefined> {
  if (signal.aborted) return;
  let previous = await read();
  yield new Set(previous.keys());
  for (;;) {
    try {
      await delay(interval, { clock, signal });
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    const values = await read();
    yield changedKeys(previous, values);
    previous = values;
  }
}

// The keys whose value differs between two checks, or that only one gave.
function changedKeys<K>(
  previous: ReadonlyMap<K, unknown>,
  values: ReadonlyMap<K, unknown>,
): ReadonlySet<K> {
  const changed = new Set<K>();
  for (const [key, value] of values)
    if (!previous.has(key) || previous.get(key) !== value) changed.add(key);
  for (const key of previous.keys()) if (!values.has(key)) changed.add(key);
  return changed;
}
