/** The schedule of a send-it job, from its data, or the job's id when its data is no object. */
export type TimekeeperWarningSubject =
  | { readonly schedule: string; readonly key: string }
  | { readonly job: string };

/** A send-it job failed to forward an occurrence, and its `'error'` reached no listener, or a listener threw. */
export class TimekeeperWarning extends Error {
  readonly code = 'ZUKHRUF_SQLITE_QUEUE_SEND_IT_UNREPORTED';
  readonly detail: string;

  constructor(failure: unknown, subject: TimekeeperWarningSubject) {
    super(
      `A send-it job failed, and no 'error' listener took the failure: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'TimekeeperWarning';
    this.detail =
      'job' in subject
        ? `job: ${subject.job}`
        : `schedule: ${subject.schedule}\nkey: ${subject.key}`;
  }
}
