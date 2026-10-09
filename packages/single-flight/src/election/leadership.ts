import type { DatabaseSync } from 'node:sqlite';

/**
 * One term as the elected coordinator. It lasts until `resign` or until the
 * process dies, when the kernel releases the claim and another campaigner can win.
 */
export class Leadership implements AsyncDisposable {
  /** Grows with every term, so a newer coordinator's tokens always outrank an older one's. */
  readonly epoch: bigint;
  readonly #claim: DatabaseSync;

  constructor(epoch: bigint, claim: DatabaseSync) {
    this.epoch = epoch;
    this.#claim = claim;
  }

  async resign(): Promise<void> {
    if (!this.#claim.isOpen) return;
    this.#claim.exec('ROLLBACK');
    this.#claim.close();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.resign();
  }
}
