import type { FencingToken } from './fencing-token.ts';

/**
 * Mints fencing tokens. Callers mint for one key one at a time (a mutex holds
 * the key's lock while it calls `next`), so each token is newer than the last.
 */
export interface TokenSource {
  next(key: string): Promise<FencingToken>;
}
