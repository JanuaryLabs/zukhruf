import { SqliteStore } from '../../lock-stores/sqlite/sqlite-store.ts';
import { pollInterval } from '../timing.ts';
import { sharedByDirectory } from './directory.ts';

/** The store of a child process or a worker thread over `directory`. */
export const openInProcess = (directory: string) =>
  new SqliteStore(directory, { clock: globalThis, pollInterval });

export const { subject, sharing, threadSharing, disk } = sharedByDirectory(
  'SqliteStore',
  openInProcess,
  { url: new URL(import.meta.url), export: 'openInProcess' },
  { grantLatency: 20 },
);
