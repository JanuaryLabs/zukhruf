import type { Worker } from 'node:worker_threads';

import { CounterTokenSource, type TokenSource } from '@zukhruf/fencing';
import { WorkerConnection } from '@zukhruf/rpc';

import { DelegatingLockStore } from '../remote/delegating-lock-store.ts';
import { LockCoordinator } from '../remote/lock-coordinator.ts';
import { type LockResponse, lockChannel } from '../remote/protocol.ts';

export interface ThreadLockCoordinatorOptions {
  /** Defaults to an in-memory counter, which lives as long as this process. */
  tokens?: TokenSource;
}

/**
 * Grants keys to the thread that owns it and to every worker thread it adopts,
 * which use `ThreadStore`. One thread decides every grant, so two threads can
 * never both be granted a key. Its reach is one process.
 */
export class ThreadLockCoordinator extends DelegatingLockStore {
  readonly #coordinator: LockCoordinator;

  constructor({
    tokens = new CounterTokenSource(),
  }: ThreadLockCoordinatorOptions = {}) {
    const coordinator = new LockCoordinator({ tokens });
    super(coordinator);
    this.#coordinator = coordinator;
  }

  /** Serves `worker`. When the thread stops, everything it held or waited for is released. */
  adopt(worker: Worker) {
    this.#coordinator.serve(
      new WorkerConnection<LockResponse>(worker, lockChannel),
    );
  }
}
