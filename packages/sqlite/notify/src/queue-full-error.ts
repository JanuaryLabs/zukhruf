/** The queue holds `maxQueuedNotifications` rows that a listener has not read. Postgres's message and code. */
export class QueueFullError extends Error {
  /** ERRCODE_PROGRAM_LIMIT_EXCEEDED. */
  readonly code = '54000';

  constructor() {
    super('too many notifications in the NOTIFY queue');
    this.name = 'QueueFullError';
  }
}
