import type { Job } from './job.ts';

/** A job for the daemons of the system domain. */
export type DaemonJob = Job & {
  UserName?: string;
  /** Without it, the primary group of UserName. */
  GroupName?: string;
  /** true by default. Ignored without UserName. */
  InitGroups?: boolean;
};
