/** The leader of a socket store failed to check the presence of a recovering session. It ends its term. */
export class LockServerWarning extends Error {
  readonly code = 'ZUKHRUF_MUTEX_LOCK_SERVER_RECOVERY_CHECK_FAILED';
  readonly detail: string;

  constructor(failure: unknown, { session }: { session: string }) {
    super(
      `The recovery check of a session failed, and the server ends its term: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'LockServerWarning';
    this.detail = `session: ${session}`;
  }
}
