import { Latch } from '@zukhruf/async';

/**
 * A held key lock of a flight this process leads. It lets the lock go only
 * when the work has settled and the flight needs nothing more from this
 * process: its landing was acknowledged, its lease was lost, or the client
 * closed. Until both, the key stays this process's, so no other process starts
 * the work beside it; a cancel or a dispose alone never frees it.
 */
export class KeyHold {
  readonly #workEnded = new Latch();
  readonly #flightEnded = new Latch();
  readonly #released = new Latch();

  constructor(lock: Disposable) {
    void Promise.all([this.#workEnded.wait(), this.#flightEnded.wait()]).then(
      () => {
        try {
          lock[Symbol.dispose]();
        } finally {
          // Even when the dispose throws, a run that waits for this key must go
          // on: the coordinator's check of the lock decides whether it leads.
          this.#released.open();
        }
      },
    );
  }

  /** The work settled, or never runs. */
  workEnded(): void {
    this.#workEnded.open();
  }

  /** The flight needs nothing more from this process. */
  flightEnded(): void {
    this.#flightEnded.open();
  }

  /** Resolves once the lock is let go. */
  released(): Promise<void> {
    return this.#released.wait();
  }
}
