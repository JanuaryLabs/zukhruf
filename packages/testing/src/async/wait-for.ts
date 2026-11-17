import { poll, untilAborted } from '@zukhruf/async';

export interface WaitForOptions {
  /** The limit of the wait, for example `t.signal`. The wait rejects with its reason. */
  signal: AbortSignal;
  /** Milliseconds between the end of a failed check and the next check. 50 by default. */
  interval?: number;
}

/**
 * Calls `check` until it returns without an error, and resolves with its
 * value. When `signal` aborts, also during a check, the wait stops its timer
 * and rejects with `signal.reason`, with the last error of `check` as its
 * `cause`. The waits run on real time, so a test that moves a fake clock does
 * not move them.
 */
export async function waitFor<T>(
  check: () => T | PromiseLike<T>,
  { signal, interval = 50 }: WaitForOptions,
): Promise<T> {
  let failure: { error: unknown } | undefined;
  try {
    const passed = await poll(
      async () => {
        try {
          return { value: await untilAborted(Promise.try(check), signal) };
        } catch (error) {
          if (signal.aborted) throw error;
          failure = { error };
          return undefined;
        }
      },
      { interval, signal, clock: globalThis },
    );
    return passed.value;
  } catch (error) {
    if (
      failure !== undefined &&
      error === signal.reason &&
      typeof error === 'object' &&
      error !== null
    )
      Object.assign(error, { cause: failure.error });
    throw error;
  }
}
