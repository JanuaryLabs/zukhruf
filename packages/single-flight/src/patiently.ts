import { setTimeout as delay } from 'node:timers/promises';

/** How long to retry a file operation that Windows refuses for a moment. */
const WINDOWS_PATIENCE = 1000;

/**
 * Windows refuses a file for a moment while another process has it open, for
 * example a joiner that reads the record while the holder replaces it. The
 * error code is the same as for a real permission denial, so a refusal is
 * retried only for a limited time.
 */
function isRefusedForNow(error: unknown): boolean {
  return (
    process.platform === 'win32' &&
    error instanceof Error &&
    'code' in error &&
    ['EPERM', 'EACCES', 'EBUSY'].includes(String(error.code))
  );
}

/** Runs `operation`, and runs it again while Windows refuses the file for a moment. */
export async function patiently<T>(operation: () => Promise<T>): Promise<T> {
  const started = performance.now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        !isRefusedForNow(error) ||
        performance.now() - started > WINDOWS_PATIENCE
      )
        throw error;
      await delay(Math.min(5 * 2 ** attempt, 100));
    }
  }
}
