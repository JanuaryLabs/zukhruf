import { FencingToken } from './fencing-token.ts';
import type { TokenSource } from './token-source.ts';

/**
 * Counts in memory, so tokens restart when the process does. Only fence
 * resources that do not outlive the process with it.
 */
export class CounterTokenSource implements TokenSource {
  #last = 0n;

  async next(_key: string): Promise<FencingToken> {
    this.#last++;
    return new FencingToken(this.#last);
  }
}
