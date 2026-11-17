import type { Check } from './check.ts';
import { Future } from './future.ts';

// The outcome of one read in each check. The future keeps a failed read as
// data (ADR 0014), so it rejects only for the callers that wait.
export class Once<T> {
  readonly #outcomes = new WeakMap<Check, Future<T>>();

  of(check: Check, read: () => Promise<T>): Promise<T> {
    let outcome = this.#outcomes.get(check);
    if (outcome === undefined) {
      outcome = Future.run(read);
      this.#outcomes.set(check, outcome);
    }
    return outcome.wait();
  }
}
