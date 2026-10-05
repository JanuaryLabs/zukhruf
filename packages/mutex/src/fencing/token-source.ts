import type { FencingToken } from './fencing-token.ts';

/**
 * Mints fencing tokens. Callers hold the key's lock while calling `next`, so
 * minting for one key is never concurrent and each token is newer than the last.
 */
export interface TokenSource {
  next(key: string): Promise<FencingToken>;
}
