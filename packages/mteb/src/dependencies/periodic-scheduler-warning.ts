/** A call of the function of a `PeriodicScheduler` failed. The next call comes at the next interval. */
export class PeriodicSchedulerWarning extends Error {
  readonly code = 'ZUKHRUF_MTEB_PERIODIC_CALL_FAILED';
  readonly detail: string;

  constructor(failure: unknown, { interval }: { interval: number }) {
    super(
      `A call of the periodic scheduler failed, and the next call comes at the next interval: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'PeriodicSchedulerWarning';
    this.detail = `interval: ${interval} s`;
  }
}
