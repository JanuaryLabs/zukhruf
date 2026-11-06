import type { Journal } from './journal.ts';

/**
 * A journal that changes nothing, for an owner that sets its own journal: a
 * lock file whose PRAGMA must wait for the lock, so it cannot run at the open
 * (ADR 0004).
 */
export class UnchangedJournal implements Journal {
  apply(): void {}
}
