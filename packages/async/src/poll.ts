import { setTimeout as delay } from 'node:timers/promises';

import { untilAborted } from './until-aborted.ts';

export interface PollOptions {
  /** Milliseconds to wait after an attempt that gave nothing. */
  interval: number;
  /** Stops the wait between two attempts. The poll then rejects with `signal.reason`. */
  signal: AbortSignal | undefined;
  /**
   * A `performance.now()` time. After it, an attempt that gives nothing
   * resolves the poll with `undefined`. The first attempt always occurs.
   */
  deadline?: number | undefined;
  /**
   * The `ref` of the Node.js timer of the wait between two attempts. With
   * `false`, the wait does not keep the process alive: the process can end
   * while the poll is pending. Without it, Node.js keeps its default.
   */
  ref?: boolean;
}

/**
 * Calls `attempt` until it gives a value other than `undefined`, and waits
 * `interval` between two attempts. An error from `attempt` rejects the poll
 * unchanged.
 */
export function poll<T>(
  attempt: () => Promise<T | undefined>,
  options: PollOptions & { deadline: number },
): Promise<T | undefined>;
export function poll<T>(
  attempt: () => Promise<T | undefined>,
  options: PollOptions & { deadline?: undefined },
): Promise<T>;
export async function poll<T>(
  attempt: () => Promise<T | undefined>,
  { interval, signal, deadline, ref }: PollOptions,
): Promise<T | undefined> {
  for (;;) {
    const value = await attempt();
    if (value !== undefined) return value;
    if (deadline !== undefined && performance.now() >= deadline) {
      return undefined;
    }
    // delay's signal frees the timer; untilAborted rejects with the reason.
    await untilAborted(delay(interval, undefined, { signal, ref }), signal);
  }
}
