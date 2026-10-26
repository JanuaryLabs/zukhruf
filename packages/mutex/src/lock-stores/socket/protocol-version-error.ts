/**
 * The socket store's leader speaks another protocol, so this process cannot
 * use it. Run one version of the protocol per lock directory.
 */
export class ProtocolVersionError extends Error {
  /** The protocol this process speaks. */
  readonly ours: number;
  /** The protocol the leader speaks. */
  readonly theirs: number;

  constructor(ours: number, theirs: number) {
    super(
      `The socket store's leader speaks protocol version ${theirs}, and this process speaks version ${ours}. Run one version per lock directory.`,
    );
    this.name = 'ProtocolVersionError';
    this.ours = ours;
    this.theirs = theirs;
  }
}
