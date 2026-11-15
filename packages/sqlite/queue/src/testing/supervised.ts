import type { RunOptions } from '../parity/backends.ts';

// Every supervisor timer at its 1 s minimum, so each second's tick runs a
// cache refresh and a supervise pass that monitors and maintains every queue.
export const supervised = {
  supervise: true,
  superviseIntervalSeconds: 1,
  monitorIntervalSeconds: 1,
  maintenanceIntervalSeconds: 1,
  queueCacheIntervalSeconds: 1,
} satisfies RunOptions;
