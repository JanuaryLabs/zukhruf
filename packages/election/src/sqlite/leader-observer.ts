import { type Clock, Future } from '@zukhruf/async';

import { type Left, readLeader } from './leader-reader.ts';

/**
 * A reader of the leader's pipe that never tries the claim, after etcd's
 * `Election.Observe` (ADR 0009). One observer reads one term. Neither its
 * connection nor its deadline keeps the process alive.
 */
export class LeaderObserver implements Disposable {
  readonly #stop = new AbortController();
  readonly #left = new Future<Left | 'absent'>();

  constructor(recordPath: string, clock: Clock) {
    readLeader(recordPath, {
      clock,
      ref: false,
      signal: this.#stop.signal,
    }).then(
      (left) => this.#left.resolve(left),
      (error: unknown) => {
        // After a disposal, `left` tells nothing.
        if (!this.#stop.signal.aborted) this.#left.reject(error);
      },
    );
  }

  /**
   * Resolves `'closed'` when the leader left, `'ended'` when this observer
   * ended a silent leader and its pipe closed, and `'absent'` when it held no
   * connection to a leader's pipe: no leader served one, the pipe was another
   * user's, or its listen queue was full. Rejects with any other error.
   * Never settles after a disposal.
   */
  get left(): Promise<Left | 'absent'> {
    return this.#left.wait();
  }

  /** Closes the connection and clears the deadline. */
  [Symbol.dispose](): void {
    this.#stop.abort();
  }
}
