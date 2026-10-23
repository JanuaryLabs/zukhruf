import { Latch } from '@zukhruf/async';

type Outcome<T> = { value: T } | { error: unknown };

// An operation in flight that a later caller shares, as pg-boss shares its
// #starting, #stopping and #maintaining promises (node_modules/pg-boss/dist/
// index.js:111-131, 199-212, boss.js:173-199). It holds the outcome in a
// one-shot latch, so nothing rejects that no caller awaits.
export class InFlight<T> {
  readonly #outcome = new Latch<Outcome<T>>();

  constructor(operation: Promise<T>) {
    operation.then(
      (value) => this.#outcome.open({ value }),
      (error: unknown) => this.#outcome.open({ error }),
    );
  }

  // The operation's own value or rejection.
  async result(): Promise<T> {
    const outcome = await this.#outcome.wait();
    if ('error' in outcome) {
      throw outcome.error;
    }
    return outcome.value;
  }

  // Resolves when the operation settles, whichever way.
  async settled(): Promise<void> {
    await this.#outcome.wait();
  }
}
