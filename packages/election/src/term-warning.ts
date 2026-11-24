/** A lost term failed to stop watching its claim or to free it. The term still ends. */
export class TermWarning extends Error {
  readonly code = 'ZUKHRUF_ELECTION_TERM_FREE_FAILED';
  readonly detail: string;

  constructor(
    failure: unknown,
    { election, epoch }: { election: string; epoch: bigint },
  ) {
    super(
      `The lost term failed to stop watching its claim or to free it, and it ends anyway: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'TermWarning';
    this.detail = `election: ${election}\nepoch: ${epoch}`;
  }
}
