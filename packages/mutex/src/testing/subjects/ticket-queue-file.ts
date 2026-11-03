import { TicketQueueFileStore } from '../../lock-stores/file-system/ticket-queue-file-store.ts';
import { pollInterval } from '../timing.ts';
import { sharedByDirectory } from './directory.ts';

/** The store of a child process or a worker thread over `directory`. */
export const openInProcess = (directory: string) =>
  new TicketQueueFileStore(directory, { clock: globalThis, pollInterval });

export const { subject, sharing, threadSharing, disk } = sharedByDirectory(
  'TicketQueueFileStore',
  openInProcess,
  { url: new URL(import.meta.url), export: 'openInProcess' },
  { grantLatency: 20, releaseLatency: 10 },
);
