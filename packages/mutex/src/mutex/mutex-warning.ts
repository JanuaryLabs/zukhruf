/** A caller cancelled, the acquire then got a lease, and its give-back failed. */
export class MutexWarning extends Error {
  readonly code = 'ZUKHRUF_MUTEX_GIVE_BACK_FAILED';
  readonly detail: string;

  constructor(failure: unknown, { key }: { key: string }) {
    super(
      `The give-back of a lease that a cancelled acquire got failed, and its caller already rejected: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'MutexWarning';
    this.detail = `key: ${key}`;
  }
}
