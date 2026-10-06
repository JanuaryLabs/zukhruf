import type { AcquireMode } from '../acquire-mode.ts';
import type { Lease } from '../lease.ts';
import type { AcquireOptions, LockStore } from '../lock-store.ts';

/** Waits until the key is granted, so the task always runs. */
export class WaitMode implements AcquireMode<'always'> {
  readonly outcome = 'always' as const;

  acquire(
    store: LockStore,
    key: string,
    options: AcquireOptions,
  ): Promise<Lease> {
    return store.acquire(key, options);
  }
}
