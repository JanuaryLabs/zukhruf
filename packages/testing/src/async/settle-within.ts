import { timeout } from '@zukhruf/async';

export async function settleWithin<T>(
  promise: PromiseLike<T>,
  label: string,
  timeoutMs = 5_000,
): Promise<T> {
  // A real deadline: it bounds how long the test waits, so a fake clock that
  // the test moves must not end it. It keeps the process alive, so a promise
  // that never settles fails with the label.
  using limit = timeout(timeoutMs, { clock: globalThis, ref: true });
  const expired = Promise.withResolvers<never>();
  limit.signal.addEventListener(
    'abort',
    () => expired.reject(new Error(`timed out waiting for: ${label}`)),
    { once: true },
  );
  return await Promise.race([promise, expired.promise]);
}
