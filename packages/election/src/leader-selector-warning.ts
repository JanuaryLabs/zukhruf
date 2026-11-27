/** A campaign of a `LeaderSelector` with `autoRequeue` failed. The selector waits the duration of its `backoff`, and campaigns again. */
export class LeaderSelectorWarning extends Error {
  readonly code = 'ZUKHRUF_ELECTION_LEADER_SELECTOR_CAMPAIGN_FAILED';
  readonly detail: string;

  constructor(failure: unknown, { election }: { election: string }) {
    super(
      `The campaign failed, and the selector campaigns again: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'LeaderSelectorWarning';
    this.detail = `election: ${election}`;
  }
}
