import type { Clock } from '@zukhruf/async';
import { LeaderElection, type Term } from '@zukhruf/election';

import type { Outcome } from '../mutex/acquire-mode.ts';
import { SkipIfBusyMode } from '../mutex/acquire-modes/skip-if-busy-mode.ts';
import { WaitMode } from '../mutex/acquire-modes/wait-mode.ts';
import type { Key } from '../mutex/key.ts';
import { KeyAttempt } from './key-attempt.ts';

export interface MutexElectionOptions {
  /** Its holder leads. The election picks the acquire mode of each step, so the key's own mode does not count. */
  key: Key<Outcome>;
  /** Times the deadline of a campaign: `globalThis` in production, a fake clock in a test. */
  clock: Clock;
}

const tryOnce = new SkipIfBusyMode();
const wait = new WaitMode();

/**
 * Elects the holder of a key as the leader, so each lock store is a backend
 * of `LeaderElection`, as client-go's `LeaseLock` is one of
 * `resourcelock.Interface` (ADR 0036). Its name is the name of the key. The
 * epoch of a term is the fencing token of its grant.
 */
export class MutexElection extends LeaderElection<KeyAttempt> {
  readonly #key: Key<Outcome>;

  constructor({ key, clock }: MutexElectionOptions) {
    super(key.name, clock);
    this.#key = key;
  }

  protected async open(): Promise<KeyAttempt> {
    return new KeyAttempt();
  }

  /** One `tryAcquire`, unless a wait for a change already got the grant. */
  protected async tryClaim(
    attempt: KeyAttempt,
    signal: AbortSignal | undefined,
  ): Promise<Pick<Term, 'epoch' | 'afterCleanShutdown'> | undefined> {
    const lease = await attempt.take(this.#key, tryOnce, signal);
    return lease && { epoch: lease.token.value, afterCleanShutdown: false };
  }

  /** Waits in the line of the key, and keeps the grant for the next try. */
  protected async waitForChange(
    attempt: KeyAttempt,
    signal: AbortSignal,
  ): Promise<void> {
    await attempt.take(this.#key, wait, signal);
  }

  protected watch(
    attempt: KeyAttempt,
    lose: (reason: Error) => void,
  ): Disposable {
    return attempt.watch(lose);
  }

  /** A key keeps no state but its lock, so it has no place for the note, and each next term recovers (ADR 0036). */
  protected async recordCleanShutdown(): Promise<void> {}

  protected release(attempt: KeyAttempt): Promise<void> {
    return attempt.giveUp();
  }

  protected close(attempt: KeyAttempt): Promise<void> {
    return attempt.giveUp();
  }
}
