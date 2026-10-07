import type { FencingToken } from '../fencing/fencing-token.ts';
import type { TokenSource } from '../fencing/token-source.ts';

/** Proof that a task holds a key: pass `token` to fenced resources, and stop once `signal` aborts. */
export interface Lease {
  readonly token: FencingToken;
  /** Aborts, with a `LockLostError` as its reason, once another holder may have been granted the key. */
  readonly signal: AbortSignal;
}

/** What a lock store gives the mutex for a granted key: the lease and its release. Only the mutex releases. */
export interface LockHandle extends Lease, AsyncDisposable {}

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
    return {
      token,
      signal: new AbortController().signal,
      [Symbol.asyncDispose]: () => held[Symbol.asyncDispose](),
    };
  } catch (error) {
    await held[Symbol.asyncDispose]();
    throw error;
  }
}
