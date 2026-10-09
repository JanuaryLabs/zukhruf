import type { FencedLease, TokenSource } from '@zukhruf/fencing';
import { LeaseController } from '@zukhruf/lease';

/** What a lock store gives the mutex for a granted key: the lease and its release. Only the mutex releases. */
export interface LockHandle extends FencedLease, AsyncDisposable {}

/**
 * Mints the token for a lock that is already held, releasing the lock if
 * minting fails. The lock store cannot lose such a lock while its holder runs,
 * so the signal never aborts; each handle has its own, so the listeners of a
 * finished task go with it.
 */
export async function leaseFor(
  key: string,
  held: AsyncDisposable,
  tokens: TokenSource,
): Promise<LockHandle> {
  try {
    const token = await tokens.next(key);
    const lease = new LeaseController(key);
    return {
      token,
      signal: lease.signal,
      [Symbol.asyncDispose]: () => {
        lease.end();
        return held[Symbol.asyncDispose]();
      },
    };
  } catch (error) {
    await held[Symbol.asyncDispose]();
    throw error;
  }
}
