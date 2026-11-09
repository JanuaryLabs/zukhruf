import { setTimeout as delay } from 'node:timers/promises';

/** Resolves `'granted'` if `lease` arrives within `milliseconds`, otherwise `'waiting'`. */
export function grantedWithin(lease: Promise<unknown>, milliseconds: number) {
  return Promise.race([
    lease.then(() => 'granted' as const),
    delay(milliseconds, 'waiting' as const, { ref: false }),
  ]);
}
