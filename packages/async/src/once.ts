import type { Check } from './check.ts';

// The result of one read in each check. A read that throws at once gives a
// rejected result, as an async read does.
export class Once<T> {
  readonly #results = new WeakMap<Check, Promise<T>>();

  of(check: Check, read: () => Promise<T>): Promise<T> {
    const known = this.#results.get(check);
    if (known !== undefined) return known;
    const result = Promise.try(read);
    this.#results.set(check, result);
    return result;
  }
}
