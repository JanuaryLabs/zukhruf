/** The database file is missing, or this process has no access to it. */
export class UnavailableError extends Error {
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(
      `The database at ${JSON.stringify(path)} cannot be opened: the file is missing, or this process has no access to it. Give the process access, or check the path.`,
      { cause },
    );
    this.name = 'UnavailableError';
    this.path = path;
  }
}
