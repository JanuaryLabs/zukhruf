import type { KeyLocks } from '../key-lock/key-locks.ts';
import type { Party } from './party.ts';

interface ParkedRun {
  readonly party: Party;
  /** Decides the party again, in the step that wakes it. */
  readonly retry: () => void;
}

/**
 * The runs and rejoins of keys that another process holds while this
 * coordinator knows no flight of them: a leader of an earlier term that has
 * not reasserted its flight yet, or a leader whose flight ended and that
 * still lets its key go. They wait until a flight of the key starts or the
 * key's lock frees.
 *
 * Each key with parked runs has one watch of its lock. It stops when the lock
 * frees, when the key's runs were woken, when none of them waits any more, or
 * when the coordinator closes. It never keeps the process alive.
 */
export class ParkedRuns {
  readonly #locks: KeyLocks;
  readonly #closed: AbortSignal;
  readonly #parked = new Map<string, Set<ParkedRun>>();

  constructor(locks: KeyLocks, closed: AbortSignal) {
    this.#locks = locks;
    this.#closed = closed;
  }

  /** Parks `party` on `key`; `retry` runs once the key's runs are woken. */
  park(key: string, party: Party, retry: () => void): void {
    const parked = this.#parked.get(key);
    if (parked) {
      parked.add({ party, retry });
      return;
    }
    const first = new Set([{ party, retry }]);
    this.#parked.set(key, first);
    void this.#watch(key, first);
  }

  /**
   * Decides every parked run of `key` again, now, in this step. A flight of
   * the key that just started takes them before anything else is read, such
   * as a landing that arrived right behind its reassertion.
   */
  wake(key: string): void {
    const parked = this.#parked.get(key);
    if (!parked) return;
    this.#parked.delete(key);
    for (const { retry } of parked) retry();
  }

  async #watch(key: string, parked: Set<ParkedRun>) {
    const current = () => this.#parked.get(key) === parked;
    let free: boolean;
    try {
      free = await this.#locks.whenFree(
        key,
        () => current() && [...parked].some(({ party }) => party.waiting),
        this.#closed,
      );
    } catch {
      if (this.#closed.aborted) return;
      // The check is advice only (F5), so a fault counts as free: each run is
      // decided again, and a leader's own lock is the truth.
      free = true;
    }
    if (!current()) return;
    if (free) this.wake(key);
    else this.#parked.delete(key);
  }
}
