import type { Mutex } from '../mutex/mutex.ts';

/**
 * Holds `key` until the returned `release` is called, and gives the fencing
 * token of the hold. Rejects when the acquire fails.
 */
export async function hold(mutex: Mutex, key: string) {
  const entered = Promise.withResolvers<bigint>();
  const finish = Promise.withResolvers<void>();
  const held = mutex.acquire(key, async (lease) => {
    entered.resolve(lease.token.value);
    await finish.promise;
  });
  held.catch(entered.reject);
  const token = await entered.promise;
  return {
    token,
    release: async () => {
      finish.resolve();
      await held;
    },
  };
}
