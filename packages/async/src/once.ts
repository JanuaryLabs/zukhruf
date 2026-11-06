import type { Check } from './check.ts';
import { Latch } from './latch.ts';

// The outcome of one read in each check. The latch keeps the outcome as data
// (ADR 0002), so a failed read rejects only for the callers that wait. A read
// that throws at once fails as an async read does.
export class Once<T> {
  readonly #outcomes = new WeakMap<Check, Latch<PromiseSettledResult<T>>>();

  async of(check: Check, read: () => Promise<T>): Promise<T> {
    const outcome = await this.#latch(check, read).wait();
    if (outcome.status === 'rejected') throw outcome.reason;
    return outcome.value;
  }

  #latch(check: Check, read: () => Promise<T>) {
    const known = this.#outcomes.get(check);
    if (known !== undefined) return known;
    const latch = new Latch<PromiseSettledResult<T>>();
    this.#outcomes.set(check, latch);
    void Promise.allSettled([Promise.try(read)]).then(([outcome]) =>
      latch.open(outcome),
    );
    return latch;
  }
}
