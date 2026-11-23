import { SocketStore } from '../../lock-stores/socket/socket-store.ts';
import type { Fixture, Subject } from '../contract/subject.ts';
import { succeedLastLeader } from '../succeed-last-leader.ts';
import { directoryFixture, sharedByDirectory } from './directory.ts';

/** The store of a child process or a worker thread over `directory`. */
export const openInProcess = (directory: string) =>
  new SocketStore(directory, { clock: globalThis });

const shared = sharedByDirectory(
  'SocketStore',
  openInProcess,
  { url: new URL(import.meta.url), export: 'openInProcess' },
  { grantLatency: 20 },
);

export const { sharing, threadSharing, disk } = shared;

/** A scratch directory whose last leader, killed or not, is succeeded before the directory goes. */
async function succeededFixture(): Promise<Fixture> {
  await using owned = new AsyncDisposableStack();
  const directory = owned.use(await directoryFixture());
  owned.use(succeedLastLeader(directory.location));
  const cleanup = owned.move();
  return {
    location: directory.location,
    [Symbol.asyncDispose]: () => cleanup.disposeAsync(),
  };
}

export const subject: Subject = {
  ...shared.subject,
  fixture: succeededFixture,
};
