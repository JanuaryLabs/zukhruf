const SQLITE_CANTOPEN = 14;

/** Whether `error` means SQLite could not open the file, for example because it does not exist. */
export function isCantOpen(error: unknown): boolean {
  return (
    error instanceof Error &&
    'errcode' in error &&
    typeof error.errcode === 'number' &&
    (error.errcode & 0xff) === SQLITE_CANTOPEN
  );
}
