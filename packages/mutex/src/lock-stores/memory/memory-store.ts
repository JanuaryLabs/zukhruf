import { Latch, untilAborted } from '@zukhruf/async';

import { CounterTokenSource } from '../../fencing/counter-token-source.ts';
import type { TokenSource } from '../../fencing/token-source.ts';
import { type LockHandle, leaseFor } from '../../mutex/lease.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';

export interface MemoryStoreOptions {
  tokens?: TokenSource;
}

/** Per-key FIFO line of latches; locks are shared only through this instance. */
export class MemoryStore implements LockStore {
  /** For each key, the latch that the last caller in line opens when it releases. */
  readonly #lines = new Map<string, Latch>();
  readonly #tokens: TokenSource;

  constructor({ tokens = new CounterTokenSource() }: MemoryStoreOptions = {}) {
    this.#tokens = tokens;
  }

  async acquire(
    key: string,
    { signal }: AcquireOptions = {},
  ): Promise<LockHandle> {
    signal?.throwIfAborted();
    const previous = this.#lines.get(key);
    const released = new Latch();
    this.#lines.set(key, released);
    const release = async () => {
      released.open();
      if (this.#lines.get(key) === released) this.#lines.delete(key);
    };

    const turn = previous?.wait() ?? Promise.resolve();
    try {
      await untilAborted(turn, signal);
    } catch (error) {
      // A waiter cannot leave the middle of the line, so its place passes the key on when its turn comes.
      void turn.then(release);
      throw error;
    }
    return leaseFor(key, { [Symbol.asyncDispose]: release }, this.#tokens);
  }

  async tryAcquire(key: string): Promise<LockHandle | undefined> {
    if (this.#lines.has(key)) return undefined;
    return this.acquire(key);
  }

  /** The first caller in a key's line holds it, so a key with a line is held. */
  async isHeld(key: string): Promise<boolean> {
    return this.#lines.has(key);
  }
}
