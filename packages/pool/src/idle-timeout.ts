import { addAbortListener } from 'node:events';

import type { Eviction } from './eviction.ts';

// The longest delay a Node timer keeps: a longer one runs after 1 ms.
const longest = 2_147_483_647;

// Evicts a worker that stays idle for after milliseconds, as the .NET thread
// pool retires a thread after 20 s and HikariCP closes a connection after its
// idleTimeout. A job that takes the worker first starts a new wait when it
// ends.
export class IdleTimeout implements Eviction {
  readonly #after: number;

  constructor(options: { after: number }) {
    if (
      !Number.isFinite(options.after) ||
      options.after <= 0 ||
      options.after > longest
    )
      throw new RangeError(
        `An idle timeout is above 0 and at most ${longest} ms, not ${options.after}`,
      );
    this.#after = options.after;
  }

  idle(busy: AbortSignal, evict: () => void): void {
    // A signal that aborted before the call starts no timer, as when the owner
    // disposed the pool while the worker became ready.
    if (busy.aborted) return;
    const timer = setTimeout(evict, this.#after);
    addAbortListener(busy, () => clearTimeout(timer));
  }
}
