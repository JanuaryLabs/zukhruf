import { closeSync, openSync } from 'node:fs';

// The file system codes for a file, or a folder on its path, that is not there.
const missingCodes = new Set(['ENOENT', 'ENOTDIR']);
// The file system codes for a file that the system keeps from this process.
const deniedCodes = new Set(['EACCES', 'EPERM']);

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
   * means the file is missing or denied (ADR 0005), else undefined. It is a
   * MissingError or a DeniedError when the error says which (ADR 0008).
   */
  static from(path: string, error: unknown): UnavailableError | undefined {
    if (!Error.isError(error)) return undefined;
    if ('errcode' in error && typeof error.errcode === 'number') {
      if (error.errcode === SQLITE_READONLY_DIRECTORY)
        return new DeniedError(path, error);
      if (error.errcode === SQLITE_CANTOPEN) return ofCantOpen(path, error);
    }
    if ('code' in error && typeof error.code === 'string')
      return ofFileSystemCode(path, error.code, error);
    return undefined;
  }
}

/** The file of the database, or a folder on its path, is not there. */
export class MissingError extends UnavailableError {
  constructor(path: string, cause: unknown) {
    super(path, cause);
    this.name = 'MissingError';
    this.message = `The database at ${JSON.stringify(path)} cannot be opened: the file, or a folder on its path, is not there. Check the path, or make the database first.`;
  }
}

/** The system keeps this process from the file of the database, or from a folder on its path. */
export class DeniedError extends UnavailableError {
  constructor(path: string, cause: unknown) {
    super(path, cause);
    this.name = 'DeniedError';
    this.message = `The database at ${JSON.stringify(path)} cannot be opened: the system denies this process access to the file, or to a folder on its path. Give the process access.`;
  }
}

function ofFileSystemCode(
  path: string,
  code: string,
  cause: unknown,
): UnavailableError | undefined {
  if (missingCodes.has(code)) return new MissingError(path, cause);
  if (deniedCodes.has(code)) return new DeniedError(path, cause);
  return undefined;
}

// SQLite gives CANTOPEN for a missing file and for a denied one, so a
// read-only open of the file system asks again and its code decides. A stat
// is the wrong question: it succeeds on a file that the system denies.
function ofCantOpen(path: string, cause: unknown): UnavailableError {
  // SQLite reads a name that starts with "file:" as a URI, and the file
  // system reads it as a file name, so the second open would ask about a
  // different file.
  if (path.startsWith('file:')) return new UnavailableError(path, cause);
  let descriptor: number;
  try {
    descriptor = openSync(path, 'r');
  } catch (error) {
    return (
      (Error.isError(error) && 'code' in error && typeof error.code === 'string'
        ? ofFileSystemCode(path, error.code, cause)
        : undefined) ?? new UnavailableError(path, cause)
    );
  }
  // The file opens, so it is not missing and not denied: it changed between
  // the two opens, or SQLite could not open a file beside it.
  closeSync(descriptor);
  return new UnavailableError(path, cause);
}
