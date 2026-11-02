import { FencingToken } from './fencing-token.ts';
import type { TokenSource } from './token-source.ts';

/** The monotonic clock that a token source reads: `process` in production. */
export interface MonotonicClock {
  hrtime: { bigint(): bigint };
}

/**
 * Reads the process-wide monotonic clock, which every worker thread shares, so
 * grants serialized by a lock read strictly later times without shared memory.
 * Tokens restart when the process does.
 */
export class MonotonicClockTokenSource implements TokenSource {
  readonly #clock: MonotonicClock;
  #last = 0n;

  constructor({ clock }: { clock: MonotonicClock }) {
    this.#clock = clock;
  }

  async next(_key: string): Promise<FencingToken> {
    const now = this.#clock.hrtime.bigint();
    this.#last = now > this.#last ? now : this.#last + 1n;
    return new FencingToken(this.#last);
  }
}
