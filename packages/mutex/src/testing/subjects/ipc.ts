import { IpcLockCoordinator } from '../../lock-stores/ipc/ipc-lock-coordinator.ts';
import { IpcStore } from '../../lock-stores/ipc/ipc-store.ts';
import {
  type Host,
  type Subject,
  inMemory,
  sharesWithProcesses,
} from '../contract/subject.ts';

/** The host of IpcStore: the coordinator of its process tree. */
export interface IpcHost extends Host {
  readonly store: IpcLockCoordinator;
}

export const openInProcess = () => new IpcStore();

export const subject: Subject<IpcHost> = {
  name: 'IpcStore',
  fixture: inMemory,
  open: () => ({
    store: new IpcLockCoordinator(),
    async [Symbol.asyncDispose]() {},
  }),
  process: {
    module: { url: new URL(import.meta.url), export: 'openInProcess' },
    admit: (host, child) => host.store.adopt(child),
  },
  grantLatency: 1,
  releaseLatency: 10,
};

export const sharing = sharesWithProcesses(subject.process);
