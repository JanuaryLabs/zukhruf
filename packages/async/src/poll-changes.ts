import { setTimeout as delay } from 'node:timers/promises';

import { untilAborted } from './until-aborted.ts';

export interface PollChangesOptions {
  /** Milliseconds to wait after a check, from when the consumer asks for the next check. */
  interval: number;
  /** Stops the wait between two checks. The iteration then ends with no error. */
  signal: AbortSignal;
}

/**
 * Reads the value of each key at once, and yields all keys. Then, after each
 * `interval`, reads each value again and yields the keys whose value is not
 * `===` to the value of the previous check: an empty set when nothing changed.
 * An error from a read rejects the iteration unchanged.
 */
export async function* pollChanges<K>(
  reads: ReadonlyMap<K, () => Promise<unknown>>,
  { interval, signal }: PollChangesOptions,
): AsyncGenerator<ReadonlySet<K>, void, undefined> {
  if (signal.aborted) return;
  const seen = new Map<K, unknown>();
  for (const [key, read] of reads) seen.set(key, await read());
  yield new Set(reads.keys());
  for (;;) {
    try {
      // delay's signal frees the timer; untilAborted ends a stopped event too.
      await untilAborted(delay(interval, undefined, { signal }), signal);
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    const changed = new Set<K>();
    for (const [key, read] of reads) {
      const value = await read();
      if (value === seen.get(key)) continue;
      seen.set(key, value);
      changed.add(key);
    }
    yield changed;
  }
}
