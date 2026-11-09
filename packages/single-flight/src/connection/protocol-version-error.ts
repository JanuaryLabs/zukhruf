/**
 * The single flight's coordinator speaks another protocol version, so this
 * process cannot use it. Run one version of the protocol per flight directory.
 */
export class ProtocolVersionError extends Error {
  /** The protocol this process speaks. */
  readonly ours: number;
  /** The protocol the coordinator speaks. */
  readonly theirs: number;

  constructor(ours: number, theirs: number) {
    super(
      `The single flight's coordinator speaks protocol version ${theirs}, and this process speaks version ${ours}. Run one version per flight directory.`,
    );
    this.name = 'ProtocolVersionError';
    this.ours = ours;
    this.theirs = theirs;
  }
}
