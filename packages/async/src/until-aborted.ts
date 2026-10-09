import { addAbortListener } from 'node:events';

/**
 * Settles like `promise`, or rejects with `signal.reason` first if `signal` aborts.
 * Listens through `addAbortListener`, so a listener that stops the abort event
 * cannot leave the wait pending.
 */
export function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    // Also calls the listener when the signal aborted before the call.
    const listening = addAbortListener(signal, () => reject(signal.reason));
    promise.then(
      (value) => {
        listening[Symbol.dispose]();
        resolve(value);
      },
      (error: unknown) => {
        listening[Symbol.dispose]();
        reject(error);
      },
    );
  });
}
