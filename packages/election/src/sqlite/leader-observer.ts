import { type Clock, Latch } from '@zukhruf/async';

import { type Left, readLeader } from './leader-reader.ts';

/** How the observation ended, as data: a latch never rejects. */
type Outcome =
  { failed: false; left: Left | 'absent' } | { failed: true; error: unknown };

/**
 * A reader of the leader's pipe that never tries the claim, after etcd's
 * `Election.Observe` (ADR 0009). One observer reads one term. Neither its
 * connection nor its deadline keeps the process alive.
 */
export class LeaderObserver implements Disposable {
  readonly #stop = new AbortController();
  readonly #outcome = new Latch<Outcome>();

  constructor(recordPath: string, clock: Clock) {
    readLeader(recordPath, {
      clock,
      ref: false,
      signal: this.#stop.signal,
    }).then(
      (left) => this.#outcome.open({ failed: false, left }),
      (error: unknown) => {
        // After a disposal, `left` tells nothing.
        if (!this.#stop.signal.aborted)
          this.#outcome.open({ failed: true, error });
      },
    );
  }

  /**
   * Resolves `'closed'` when the leader left, `'ended'` when this observer
   * ended a silent leader and its pipe closed, and `'absent'` when no leader
   * served a pipe. Rejects with any other error. Never settles after a
   * disposal.
   */
  get left(): Promise<Left | 'absent'> {
    return this.#outcome.wait().then((outcome) => {
      if (outcome.failed) throw outcome.error;
      return outcome.left;
    });
  }

  /** Closes the connection and clears the deadline. */
  [Symbol.dispose](): void {
    this.#stop.abort();
  }
}
