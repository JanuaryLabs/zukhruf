import { untilAborted } from '@zukhruf/async';

/**
 * Runs the tasks of one fan-out at once (ADR 0014), as Go's
 * errgroup.WithContext: each task gets one signal linked to the caller's,
 * and the first task that throws aborts the others with its error as the
 * reason, and the fan-out rejects with it. A task that must not stop its
 * siblings catches its own error and returns. The results come in the order
 * of the tasks. The caller's abort rejects at once with the caller's reason
 * (`untilAborted`), whatever the tasks do.
 */
export const fanOut = async <T>(
  caller: AbortSignal | undefined,
  tasks: readonly ((signal: AbortSignal) => Promise<T>)[],
): Promise<T[]> => {
  const siblings = new AbortController();
  const signal =
    caller === undefined
      ? siblings.signal
      : AbortSignal.any([caller, siblings.signal]);
  return await untilAborted(
    Promise.all(
      tasks.map(async (task) => {
        try {
          return await task(signal);
        } catch (error) {
          siblings.abort(error);
          throw error;
        }
      }),
    ),
    caller,
  );
};
