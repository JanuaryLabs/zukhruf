// Postgres and @zukhruf/sqlite-notify take a channel name shorter than
// NAMEDATALEN (64) bytes.
const NAMEDATALEN = 64;
// The two channels of a pool end in these (ADR 0018). "new-job" is the longer,
// so a name whose new-job channel fits fits both.
const NEW_JOB = 'new-job';
const OUTPUT = 'output';

/** The name, the revision and the job rules of a pool, with the types of its input and its output. */
export class WorkerKind<Input, Output> {
  readonly name: string;
  readonly revision: number;
  readonly policy: 'standard' | 'exclusive';
  readonly retryLimit: number;
  readonly expireInSeconds: number;
  /** The queue of this revision in the store, `<name>.r<revision>` (ADR 0022). */
  readonly queue: string;
  // Holds the types: without a member that uses them, any kind would be
  // assignable to any other.
  declare private readonly types: (input: Input) => Output;

  constructor(options: {
    name: string;
    revision: number;
    policy: 'standard' | 'exclusive';
    retryLimit: number;
    expireInSeconds: number;
  }) {
    const channel = `${options.name}.${NEW_JOB}`;
    if (Buffer.byteLength(channel) >= NAMEDATALEN)
      throw new RangeError(
        `worker kind name too long: its channel "${channel}" must be shorter than ${NAMEDATALEN} bytes`,
      );
    this.name = options.name;
    this.revision = options.revision;
    this.policy = options.policy;
    this.retryLimit = options.retryLimit;
    this.expireInSeconds = options.expireInSeconds;
    this.queue = `${options.name}.r${options.revision}`;
  }
}

/** The channel on which the owner hears of a new job of the kind, with its revision (ADR 0018). */
export function newJobChannel<Input, Output>(
  kind: WorkerKind<Input, Output>,
): string {
  return `${kind.name}.${NEW_JOB}`;
}

/** The channel on which each waiting Pool hears of an output of the kind, with the job's id (ADR 0018). */
export function outputChannel<Input, Output>(
  kind: WorkerKind<Input, Output>,
): string {
  return `${kind.name}.${OUTPUT}`;
}
