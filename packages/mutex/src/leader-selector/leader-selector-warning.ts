/** What a `LeaderSelector` leads over: a key of the mutex, or a `LeaderElection`, by its name. */
export type LeaderSelectorSource =
  { readonly key: string } | { readonly election: string };

/** An acquire of a `LeaderSelector` with `autoRequeue` failed. The selector waits its back-off and tries again. */
export class LeaderSelectorWarning extends Error {
  readonly code = 'ZUKHRUF_MUTEX_LEADER_SELECTOR_ACQUIRE_FAILED';
  readonly detail: string;

  constructor(failure: unknown, source: LeaderSelectorSource) {
    super(
      `The acquire failed, and the selector tries again: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'LeaderSelectorWarning';
    this.detail =
      'key' in source ? `key: ${source.key}` : `election: ${source.election}`;
  }
}
