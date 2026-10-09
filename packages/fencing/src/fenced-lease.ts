import type { Lease } from '@zukhruf/lease';

import type { FencingToken } from './fencing-token.ts';

/**
 * What an issuer of fenced access, such as a mutex or a single flight, gives
 * its holder: the lease warns the holder, and the token lets a fenced resource
 * refuse the holder's writes once a newer holder has written.
 */
export interface FencedLease extends Lease {
  readonly token: FencingToken;
}
