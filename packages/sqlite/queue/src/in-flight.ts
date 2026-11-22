import { Future } from '@zukhruf/async';

type Current<T> =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly operation: Future<T> };

// The one operation of a kind that runs at a time, as pg-boss runs one start,
// one stop and one maintenance pass (node_modules/pg-boss/dist/
// index.js:133-161, 259-284, boss.js:192-218, timekeeper.js:552-619). A later
// caller shares the one in flight, as pg-boss shares its #starting, #stopping
// and #maintaining promises (index.js:140-160, 271-284, boss.js:192-218).
export class CurrentOperation<T> {
  #current: Current<T> = { kind: 'idle' };

  // The operation in flight, if one is.
  get inFlight(): Future<T> | undefined {
    return this.#current.kind === 'running'
      ? this.#current.operation
      : undefined;
  }

  // Holds `operation` as the one in flight until it settles.
  async run(operation: Promise<T>): Promise<T> {
    this.#current = {
      kind: 'running',
      operation: Future.run(() => operation),
    };
    try {
      return await operation;
    } finally {
      this.#current = { kind: 'idle' };
    }
  }
}
