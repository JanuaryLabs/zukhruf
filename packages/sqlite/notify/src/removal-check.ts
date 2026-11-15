import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type { Wakes } from './wakes.ts';

/**
 * Tells whether a caller's transaction committed the removal of the rows of
 * dead listeners. On the microtask after the notify, the caller's synchronous
 * transaction has ended (ADR 0004); a read then finds the rows gone after a
 * commit, and still there after a rollback (ADR 0010).
 */
export class RemovalCheck {
  readonly #database: DatabaseSync;
  readonly #wakes: Wakes;
  readonly #fail: (error: unknown) => void;
  readonly #listener: StatementSync;
  // The dead listeners whose rows the notifies of this turn removed; a
  // microtask is queued while the map is not empty.
  readonly #pending = new Map<string, string>();

  constructor(
    database: DatabaseSync,
    wakes: Wakes,
    fail: (error: unknown) => void,
  ) {
    this.#database = database;
    this.#wakes = wakes;
    this.#fail = fail;
    this.#listener = database.prepare(
      'SELECT 1 FROM zukhruf_notify_listener WHERE id = ?',
    );
  }

  /** After a notify in a caller's transaction that removed the rows of the dead listeners. */
  removedInCallersTransaction(dead: ReadonlyMap<string, string>): void {
    if (dead.size === 0) return;
    if (this.#pending.size === 0) queueMicrotask(() => this.#check());
    for (const [id, address] of dead) this.#pending.set(id, address);
  }

  // A transaction still open belongs to a caller that keeps it across an
  // await: its end is unknown, and the next notify removes the rows again.
  #check(): void {
    const pending = [...this.#pending];
    this.#pending.clear();
    if (this.#database.isTransaction) return;
    try {
      this.#wakes.removed(
        new Map(pending.filter(([id]) => this.#listener.get(id) === undefined)),
      );
    } catch (error) {
      this.#fail(error);
    }
  }
}
