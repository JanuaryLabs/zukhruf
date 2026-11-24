/** The master of a ref'd shared connection went away, and its election failed while no channel waits for it. */
export class SharedConnectionWarning extends Error {
  readonly code = 'ZUKHRUF_SSH_SHARED_CONNECTION_ELECTION_FAILED';
  readonly detail: string;

  constructor(failure: unknown, { socket }: { socket: string }) {
    super(
      `The election of a ref'd shared connection failed, and its next channel elects again: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'SharedConnectionWarning';
    this.detail = `socket: ${socket}`;
  }
}
