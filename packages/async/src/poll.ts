import type { Clock } from './clock.ts';
import { delay } from './delay.ts';

export interface PollOptions {
  /** Milliseconds to wait after an attempt that gave nothing. */
  interval: number;
  /** Stops the wait between two attempts. The poll then rejects with `signal.reason`. */
  signal: AbortSignal | undefined;
  /** The clock that the wait runs on: `globalThis` in production, a fake clock in a test. */
  clock: Clock;
  /**
   * A `clock.performance.now()` time. After it, an attempt that gives nothing
   * resolves the poll with `undefined`. The first attempt always occurs.
   */
  deadline?: number | undefined;
  /**
   * With `false`, the wait between two attempts does not keep the process
   * alive: `poll` calls `unref()` on the timer of the clock, when the timer has
   * one. The process can then end while the poll is pending. Without it, the
   * timer keeps its default.
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
  { interval, signal, clock, deadline, ref }: PollOptions,
): Promise<T | undefined> {
  for (;;) {
    const value = await attempt();
    if (value !== undefined) return value;
    if (deadline !== undefined && clock.performance.now() >= deadline) {
      return undefined;
    }
    await delay(interval, { clock, signal, ref });
  }
}
