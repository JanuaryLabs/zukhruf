import { FencingToken } from './fencing-token.ts';
import type { TokenSource } from './token-source.ts';

/**
 * Reads the process-wide monotonic clock, which every worker thread shares, so
 * grants serialized by a lock read strictly later times without shared memory.
 * Tokens restart when the process does.
 */
export class MonotonicClockTokenSource implements TokenSource {
  #last = 0n;

  async next(_key: string): Promise<FencingToken> {
    const now = process.hrtime.bigint();
    this.#last = now > this.#last ? now : this.#last + 1n;
    return new FencingToken(this.#last);
  }
}
