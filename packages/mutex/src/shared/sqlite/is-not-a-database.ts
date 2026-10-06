const SQLITE_NOTADB = 26;

/** Whether `error` means the file is not a SQLite database, for example a file that an older version wrote. */
export function isNotADatabase(error: unknown): boolean {
  return (
    error instanceof Error &&
    'errcode' in error &&
    typeof error.errcode === 'number' &&
    (error.errcode & 0xff) === SQLITE_NOTADB
  );
}
