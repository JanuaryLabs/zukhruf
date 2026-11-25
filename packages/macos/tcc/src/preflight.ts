// The paths of one preflight, sorted by what an open of each gave.
export class Preflight {
  readonly readable: readonly string[];
  // macOS or the file mode keeps them from the process.
  readonly denied: readonly string[];
  readonly missing: readonly string[];

  constructor(
    readable: readonly string[],
    denied: readonly string[],
    missing: readonly string[],
  ) {
    this.readable = readable;
    this.denied = denied;
    this.missing = missing;
  }
}
