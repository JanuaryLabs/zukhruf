// The SQLite result codes that zukhruf reads, by their names in SQLite
// (https://www.sqlite.org/rescode.html). A primary code fits in the low byte;
// an extended code keeps its primary code in that byte.
export const SQLITE_ERROR = 1;
export const SQLITE_BUSY = 5;
export const SQLITE_CANTOPEN = 14;
export const SQLITE_NOTADB = 26;
export const SQLITE_CONSTRAINT_FOREIGNKEY = 787;
export const SQLITE_CONSTRAINT_NOTNULL = 1299;
export const SQLITE_READONLY_DIRECTORY = 1544;
export const SQLITE_CONSTRAINT_UNIQUE = 2067;

/**
 * The result code of a SQLite error in its two parts, as go-sqlite3 names
 * them: `code` is the primary code, the same for each variant (`SQLITE_BUSY`),
 * and `extendedCode` names the variant (`SQLITE_CONSTRAINT_NOTNULL`).
 */
export interface SqliteResultCode {
  readonly code: number;
  readonly extendedCode: number;
}

/**
 * The result code of an error that node:sqlite threw, else undefined.
 * node:sqlite puts the extended result code on the error's `errcode`.
 */
export function sqliteResultCode(error: unknown): SqliteResultCode | undefined {
  if (
    !Error.isError(error) ||
    !('errcode' in error) ||
    typeof error.errcode !== 'number'
  ) {
    return undefined;
  }
  return { code: error.errcode & 0xff, extendedCode: error.errcode };
}
