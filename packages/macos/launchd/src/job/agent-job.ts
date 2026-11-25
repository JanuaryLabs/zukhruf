import type { Job } from './job.ts';

/** A job for the agents of a user. */
export type AgentJob = Job & {
  LimitLoadToSessionType?: SessionType | readonly SessionType[];
};

/** The session types of launchctl(1): Aqua is the default. */
export type SessionType = 'Aqua' | 'Background' | 'LoginWindow';
