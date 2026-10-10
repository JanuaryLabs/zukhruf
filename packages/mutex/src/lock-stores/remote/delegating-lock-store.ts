import type { LockHandle } from '../../mutex/lease.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';

/**
 * A public lock store that forwards each operation to the store that does the
 * work, so the public class names only its own constructor and extra methods.
 */
export abstract class DelegatingLockStore implements LockStore {
  readonly #inner: LockStore;

  protected constructor(inner: LockStore) {
    this.#inner = inner;
  }

  acquire(key: string, options?: AcquireOptions): Promise<LockHandle> {
    return this.#inner.acquire(key, options);
  }

  tryAcquire(key: string): Promise<LockHandle | undefined> {
    return this.#inner.tryAcquire(key);
  }

  isHeld(key: string): Promise<boolean> {
    return this.#inner.isHeld(key);
  }
}
