import { MemoryStore } from '../../lock-stores/memory/memory-store.ts';
import { type Host, type Subject, inMemory } from '../contract/subject.ts';

/** The store of an app in a child process of its own; it shares nothing with the host. */
export const openInProcess = () => new MemoryStore();

export const subject: Subject<Host> = {
  name: 'MemoryStore',
  fixture: inMemory,
  open: () => ({
    store: new MemoryStore(),
    async [Symbol.asyncDispose]() {},
  }),
  process: {
    module: { url: new URL(import.meta.url), export: 'openInProcess' },
    admit() {},
  },
  grantLatency: 1,
};
