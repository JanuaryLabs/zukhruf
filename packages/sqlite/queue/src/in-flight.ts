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

type Current<T> =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly operation: InFlight<T> };

// The one operation of a kind that runs at a time, as pg-boss runs one start,
// one stop and one maintenance pass (node_modules/pg-boss/dist/
// index.js:106-132, 192-212, boss.js:173-199, timekeeper.js:335-384).
export class CurrentOperation<T> {
  #current: Current<T> = { kind: 'idle' };

  // The operation in flight, if one is.
  get inFlight(): InFlight<T> | undefined {
    return this.#current.kind === 'running'
      ? this.#current.operation
      : undefined;
  }

  // Holds `operation` as the one in flight until it settles.
  async run(operation: Promise<T>): Promise<T> {
    this.#current = { kind: 'running', operation: new InFlight(operation) };
    try {
      return await operation;
    } finally {
      this.#current = { kind: 'idle' };
    }
  }
}
