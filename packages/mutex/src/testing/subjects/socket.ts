import { SocketStore } from '../../lock-stores/socket/socket-store.ts';
import { graceWindow, pollInterval } from '../timing.ts';
import { sharedByDirectory } from './directory.ts';

/** The store of a child process or a worker thread over `directory`. */
export const openInProcess = (directory: string) =>
  new SocketStore(directory, { clock: globalThis, pollInterval, graceWindow });

export const { subject, sharing, threadSharing, disk } = sharedByDirectory(
  'SocketStore',
  openInProcess,
  { url: new URL(import.meta.url), export: 'openInProcess' },
  { grantLatency: 20, releaseLatency: 10 },
);
