/**
 * The socket store's leader speaks another protocol, so this process cannot
 * use it. Run one version of the protocol per lock directory.
 */
export class ProtocolVersionError extends Error {
  /** The protocol this process speaks. */
  readonly ours: number;
  /** The protocol the leader speaks, or `undefined` when it closed the handshake without saying. */
  readonly theirs: number | undefined;

  constructor(ours: number, theirs: number | undefined) {
    super(
      theirs === undefined
        ? `The socket store's leader closed the handshake without an answer while it still leads, so it predates protocol version ${ours}. Stop the processes that run the older version of @zukhruf/mutex.`
        : `The socket store's leader speaks protocol version ${theirs}, and this process speaks version ${ours}. Run one version per lock directory.`,
    );
    this.name = 'ProtocolVersionError';
    this.ours = ours;
    this.theirs = theirs;
  }
}
