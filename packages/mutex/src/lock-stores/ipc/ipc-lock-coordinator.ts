import type { ChildProcess } from 'node:child_process';

import { CounterTokenSource } from '../../fencing/counter-token-source.ts';
import type { TokenSource } from '../../fencing/token-source.ts';
import type { Lease } from '../../mutex/lease.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';
import { LockCoordinator } from '../remote/lock-coordinator.ts';
import { ChildProcessConnection } from './child-process-connection.ts';

export interface IpcLockCoordinatorOptions {
  /** Defaults to an in-memory counter, which lives as long as this process. */
  tokens?: TokenSource;
}

/**
 * The parent side of IPC locking: grants keys to this process and to every
 * child it adopts, which use `IpcStore`. Its reach is one process tree.
 */
export class IpcLockCoordinator implements LockStore {
  readonly #coordinator: LockCoordinator;

  constructor({
    tokens = new CounterTokenSource(),
  }: IpcLockCoordinatorOptions = {}) {
    this.#coordinator = new LockCoordinator({ tokens });
  }

  acquire(key: string, options?: AcquireOptions): Promise<Lease> {
    return this.#coordinator.acquire(key, options);
  }

  tryAcquire(key: string): Promise<Lease | undefined> {
    return this.#coordinator.tryAcquire(key);
  }

  /**
   * Serves `child`, which must have an IPC channel. When the child exits,
   * everything it held or waited for is released.
   */
  adopt(child: ChildProcess) {
    this.#coordinator.serve(new ChildProcessConnection(child));
  }
}
