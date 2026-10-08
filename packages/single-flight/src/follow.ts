import { setTimeout as delay } from 'node:timers/promises';

import type { Mutex } from '@zukhruf/mutex';

import {
  FlightFailedError,
  FlightInterruptedError,
  FlightOutcomeLostError,
} from './errors.ts';
import type { FlightRecords, LatestFlight } from './flight-records.ts';

/** What a joiner watches while it waits for a flight in another process, and how often it looks. */
export interface Watch {
  readonly records: FlightRecords;
  readonly mutex: Mutex;
  readonly key: string;
  readonly pollInterval: number;
  /** Aborts when no caller in this process waits any more: the watch then stops. */
  readonly abandoned: AbortSignal;
}

/**
 * The flight that holds the key now, found by its record. `undefined` when
 * the key became free and no new flight began, so the caller can try to lead.
 */
export async function findFlight(
  { records, mutex, key, pollInterval, abandoned }: Watch,
  before: LatestFlight | undefined,
): Promise<string | undefined> {
  for (;;) {
    await delay(pollInterval, undefined, { signal: abandoned });
    const now = await records.latest(key);
    if (now && (now.id !== before?.id || before.status === 'running'))
      return now.id;
    if (!(await mutex.isHeld(key))) return undefined;
  }
}

/** How following ended: with the value of the flight, or with no flight to follow, so the caller tries to lead. */
export type Followed =
  | { readonly followed: true; readonly value: unknown }
  | { readonly followed: false };

/**
 * Waits for flight `id` to end and gives its value. It reads the record, not
 * the lock: back-to-back holders can keep the key held at every look, so
 * waiting for a free key could wait forever. The lock only tells whether a
 * running flight still has a holder.
 */
export async function follow(
  { records, mutex, key, pollInterval, abandoned }: Watch,
  first: string,
): Promise<Followed> {
  let id = first;
  let seenHeld = false;
  for (;;) {
    const outcome = await records.outcome(key, id);
    switch (outcome.status) {
      case 'succeeded':
        return { followed: true, value: outcome.value };
      case 'failed':
        throw new FlightFailedError(key, outcome.error);
      case 'interrupted':
        if (outcome.successor === undefined)
          throw new FlightInterruptedError(key);
        // The next holder closed a flight whose holder stopped, and began its own.
        id = outcome.successor;
        seenHeld = false;
        continue;
      case 'running':
        if (await mutex.isHeld(key)) {
          seenHeld = true;
          await delay(pollInterval, undefined, { signal: abandoned });
          continue;
        }
        // The holder can finish between the two looks: read the record again.
        if ((await records.outcome(key, id)).status !== 'running') continue;
        // A record that was running before this joiner came was left by a
        // holder that stopped long ago: there is no flight to join.
        if (!seenHeld) return { followed: false };
        // This joiner saw the holder run the flight, and the holder stopped.
        throw new FlightInterruptedError(key);
      case 'missing':
        throw new FlightOutcomeLostError(key);
    }
  }
}
