import { ThreadLockCoordinator } from '../../lock-stores/thread/thread-lock-coordinator.ts';
import { ThreadStore } from '../../lock-stores/thread/thread-store.ts';
import {
  type Host,
  type Subject,
  inMemory,
  sharesWithThreads,
} from '../contract/subject.ts';

/** The host of ThreadStore: the coordinator of its process. */
export interface ThreadHost extends Host {
  readonly store: ThreadLockCoordinator;
}

/** In a child process of its own, the child's main thread is the coordinator. */
export const openInProcess = () => new ThreadLockCoordinator();

export const openInThread = () => new ThreadStore();

const url = new URL(import.meta.url);

export const subject: Subject<ThreadHost> = {
  name: 'ThreadStore',
  fixture: inMemory,
  open: () => ({
    store: new ThreadLockCoordinator(),
    async [Symbol.asyncDispose]() {},
  }),
  process: { module: { url, export: 'openInProcess' }, admit() {} },
  grantLatency: 1,
  releaseLatency: 10,
};

export const threadSharing = sharesWithThreads<ThreadHost>({
  module: { url, export: 'openInThread' },
  admit: (host, worker) => host.store.adopt(worker),
});
