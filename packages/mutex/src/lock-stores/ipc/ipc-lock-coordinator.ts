import type { ChildProcess } from 'node:child_process';

import { CounterTokenSource, type TokenSource } from '@zukhruf/fencing';

import { DelegatingLockStore } from '../remote/delegating-lock-store.ts';
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
export class IpcLockCoordinator extends DelegatingLockStore {
  readonly #coordinator: LockCoordinator;

  constructor({
    tokens = new CounterTokenSource(),
  }: IpcLockCoordinatorOptions = {}) {
    const coordinator = new LockCoordinator({ tokens });
    super(coordinator);
    this.#coordinator = coordinator;
  }

  /**
   * Serves `child`, which must have an IPC channel. When the child exits,
   * everything it held or waited for is released.
   */
  adopt(child: ChildProcess) {
    this.#coordinator.serve(new ChildProcessConnection(child));
  }
}
