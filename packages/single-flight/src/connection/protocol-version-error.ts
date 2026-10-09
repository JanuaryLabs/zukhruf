/**
 * The single flight's coordinator speaks another protocol version, so this
 * process cannot use it. Run one version of the protocol per flight directory.
 */
export class ProtocolVersionError extends Error {
  /** The protocol this process speaks. */
  readonly ours: number;
  /** The protocol the coordinator speaks, or `undefined` when it closed the handshake without saying. */
  readonly theirs: number | undefined;

  constructor(ours: number, theirs: number | undefined) {
    super(
      theirs === undefined
        ? `The single flight's coordinator closed the handshake without an answer while it still coordinates, so it does not speak protocol version ${ours}.`
        : `The single flight's coordinator speaks protocol version ${theirs}, and this process speaks version ${ours}. Run one version per flight directory.`,
    );
    this.name = 'ProtocolVersionError';
    this.ours = ours;
    this.theirs = theirs;
  }
}
