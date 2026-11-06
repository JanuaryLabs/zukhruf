// The file system codes for a file that is missing, or that the system denies.
const unavailableCodes = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']);

// SQLite's CANTOPEN (14). A missing or denied file fails the open() syscall,
// and SQLite reports that as CANTOPEN, a privacy denial of macOS too (probed:
// a missing file or folder, chmod 000, a symlink loop and a TCC denial all
// give exactly 14).
const SQLITE_CANTOPEN = 14;
// SQLite's READONLY_DIRECTORY (1544): the folder denies the write that makes
// the journal, for example for an owner in a folder it cannot write. A plain
// READONLY (8), a reader that tries to write, is not unavailable.
const SQLITE_READONLY_DIRECTORY = 1544;

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

  /**
   * The UnavailableError for an error of SQLite or of the file system that
   * means the file is missing or denied (ADR 0005), else undefined.
   */
  static from(path: string, error: unknown): UnavailableError | undefined {
    if (!(error instanceof Error)) return undefined;
    if (
      'errcode' in error &&
      typeof error.errcode === 'number' &&
      (error.errcode === SQLITE_CANTOPEN ||
        error.errcode === SQLITE_READONLY_DIRECTORY)
    )
      return new UnavailableError(path, error);
    if (
      'code' in error &&
      typeof error.code === 'string' &&
      unavailableCodes.has(error.code)
    )
      return new UnavailableError(path, error);
    return undefined;
  }
}
