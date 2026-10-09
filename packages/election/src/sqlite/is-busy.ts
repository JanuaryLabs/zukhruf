const SQLITE_BUSY = 5;

/** Whether `error` means another connection holds a conflicting lock right now. */
export function isBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    'errcode' in error &&
    typeof error.errcode === 'number' &&
    // The low byte is the primary result code, covering SQLITE_BUSY_* variants.
    (error.errcode & 0xff) === SQLITE_BUSY
  );
}
