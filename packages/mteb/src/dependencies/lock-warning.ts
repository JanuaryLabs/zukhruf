/** At exit, the release of the codecarbon lock failed. The next lock is still released. */
export class LockWarning extends Error {
  readonly code = 'ZUKHRUF_MTEB_LOCK_RELEASE_FAILED';
  readonly detail: string;

  constructor(failure: unknown, { lockfile }: { lockfile: string }) {
    super(
      `The release of the lock at exit failed, and the next lock is released: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'LockWarning';
    this.detail = `lockfile: ${lockfile}`;
  }
}
