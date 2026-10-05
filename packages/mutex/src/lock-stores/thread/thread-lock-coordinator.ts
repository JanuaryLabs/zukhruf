import type { Worker } from 'node:worker_threads';

import { CounterTokenSource } from '../../fencing/counter-token-source.ts';
import type { TokenSource } from '../../fencing/token-source.ts';
import type { Lease } from '../../mutex/lease.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';
import { LockCoordinator } from '../remote/lock-coordinator.ts';
import { WorkerConnection } from './worker-connection.ts';

export interface ThreadLockCoordinatorOptions {
  /** Defaults to an in-memory counter, which lives as long as this process. */
  tokens?: TokenSource;
}

/**
 * Grants keys to the thread that owns it and to every worker thread it adopts,
 * which use `ThreadStore`. One thread decides every grant, so two threads can
 * never both be granted a key. Its reach is one process.
 */
export class ThreadLockCoordinator implements LockStore {
  readonly #coordinator: LockCoordinator;

  constructor({
    tokens = new CounterTokenSource(),
  }: ThreadLockCoordinatorOptions = {}) {
    this.#coordinator = new LockCoordinator({ tokens });
  }

  acquire(key: string, options?: AcquireOptions): Promise<Lease> {
    return this.#coordinator.acquire(key, options);
  }

  tryAcquire(key: string): Promise<Lease | undefined> {
    return this.#coordinator.tryAcquire(key);
  }

  /** Serves `worker`. When the thread stops, everything it held or waited for is released. */
  adopt(worker: Worker) {
    this.#coordinator.serve(new WorkerConnection(worker));
  }
}
