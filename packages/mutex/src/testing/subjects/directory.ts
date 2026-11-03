import { TemporaryFiles } from '@zukhruf/testing/fs';

import type { LockStore } from '../../mutex/lock-store.ts';
import {
  type Fixture,
  type Host,
  type OnDisk,
  type StoreModule,
  type Subject,
  sharesWithProcesses,
  sharesWithThreads,
} from '../contract/subject.ts';

/** A scratch directory as the fixture: its path is the location. */
export async function directoryFixture(): Promise<Fixture> {
  const directory = await new TemporaryFiles().directory('mutex-test-');
  return {
    location: directory.path,
    [Symbol.asyncDispose]: () => directory[Symbol.asyncDispose](),
  };
}

const isAsyncDisposable = (value: object): value is AsyncDisposable =>
  Symbol.asyncDispose in value &&
  typeof value[Symbol.asyncDispose] === 'function';

/**
 * A host lock store that each process and thread builds the same way over
 * one directory, with nothing to admit. `module` names the export that builds
 * it from a directory.
 */
export function sharedByDirectory(
  name: string,
  create: (directory: string) => LockStore,
  module: StoreModule,
  latency: { grantLatency: number; releaseLatency: number },
) {
  const open = (directory: string): Host => {
    const store = create(directory);
    return {
      store,
      async [Symbol.asyncDispose]() {
        if (isAsyncDisposable(store)) await store[Symbol.asyncDispose]();
      },
    };
  };
  const subject: Subject = {
    name,
    fixture: directoryFixture,
    open,
    process: { module, admit() {} },
    ...latency,
  };
  const disk: OnDisk<Host> = { openIn: open };
  return {
    subject,
    sharing: sharesWithProcesses(subject.process),
    threadSharing: sharesWithThreads<Host>({ module, admit() {} }),
    disk,
  };
}
