import { setTimeout as delay } from 'node:timers/promises';

import { isErrno } from './errno.ts';

/** How long to retry a file operation that Windows refuses for a moment. */
const WINDOWS_PATIENCE = 1000;

/**
 * Windows refuses a file for a moment while another program holds it open
 * with no sharing, as a virus scanner can, or while a delete of it is in
 * progress. The error code is the same as for a real permission denial, so a
 * refusal is retried only for a limited time.
 */
function isRefusedForNow(error: unknown): boolean {
  return (
    process.platform === 'win32' &&
    ['EPERM', 'EACCES', 'EBUSY'].some((code) => isErrno(error, code))
  );
}

/** Runs `operation`, and runs it again while Windows refuses the file for a moment; after that, the error reaches the caller. */
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
