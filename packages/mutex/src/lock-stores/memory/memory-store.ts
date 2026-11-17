import { Lock } from '@zukhruf/async';
import { CounterTokenSource, type TokenSource } from '@zukhruf/fencing';

import { type LockHandle, leaseFor } from '../../mutex/lease.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';

export interface MemoryStoreOptions {
  tokens?: TokenSource;
}

/** The lock of one key, and the count of its callers: the holder and the callers that wait in its line. */
interface Line {
  readonly lock: Lock;
  callers: number;
}

/** Per-key FIFO line on a `Lock`; locks are shared only through this instance. */
export class MemoryStore implements LockStore {
  /** The line of each key that a caller holds or waits for. */
  readonly #lines = new Map<string, Line>();
  readonly #tokens: TokenSource;

  constructor({ tokens = new CounterTokenSource() }: MemoryStoreOptions = {}) {
    this.#tokens = tokens;
  }

  /** A cancel of `signal` takes the caller out of the line, so the caller behind it moves up. */
  async acquire(
    key: string,
    { signal }: AcquireOptions = {},
  ): Promise<LockHandle> {
    const { lock, place } = this.#join(key);
    using joined = place;
    joined.use(await lock.acquire({ signal }));
    return await this.#lease(key, joined.move());
  }

  async tryAcquire(key: string): Promise<LockHandle | undefined> {
    const { lock, place } = this.#join(key);
    using joined = place;
    const held = lock.tryAcquire();
    if (!held) return undefined;
    joined.use(held);
    return await this.#lease(key, joined.move());
  }

  /** The first caller in a key's line holds it, so a key with a line is held. */
  async isHeld(key: string): Promise<boolean> {
    return this.#lines.has(key);
  }

  /** True while a caller holds a key. A caller waits only behind a holder, so `false` also means that nobody waits. */
  get holdsAnyKey(): boolean {
    return this.#lines.size > 0;
  }

  /** Joining is synchronous, so the order of the line is the order of the calls. Dispose the place to leave the line. */
  #join(key: string): { lock: Lock; place: DisposableStack } {
    const line = this.#lines.getOrInsertComputed(key, () => ({
      lock: new Lock(),
      callers: 0,
    }));
    line.callers++;
    const place = new DisposableStack();
    place.defer(() => {
      if (--line.callers === 0) this.#lines.delete(key);
    });
    return { lock: line.lock, place };
  }

  /** The release frees the lock and leaves the line in the same turn, so a look right after it sees the key free. */
  #lease(key: string, held: DisposableStack): Promise<LockHandle> {
    return leaseFor(
      key,
      { [Symbol.asyncDispose]: async () => held.dispose() },
      this.#tokens,
    );
  }
}
