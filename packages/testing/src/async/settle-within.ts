import { timeout } from '@zukhruf/async';

export async function settleWithin<T>(
  promise: PromiseLike<T>,
  label: string,
  timeoutMs = 5_000,
): Promise<T> {
  // A real deadline: it bounds how long the test waits, so a fake clock that
  // the test moves must not end it.
  using limit = timeout(timeoutMs, { clock: globalThis });
  const expired = Promise.withResolvers<never>();
  limit.signal.addEventListener(
    'abort',
    () => expired.reject(new Error(`timed out waiting for: ${label}`)),
    { once: true },
  );
  return await Promise.race([promise, expired.promise]);
}
