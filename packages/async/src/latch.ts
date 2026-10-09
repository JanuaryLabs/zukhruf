/**
 * A gate that starts closed and opens once, with a value. It never closes
 * again and never rejects, so a wait that starts after it opened ends at once
 * with the same value.
 */
export class Latch<T = void> {
  /** Holds the value in a box, so it never adopts a promise and never rejects, whatever `T` is. */
  // eslint-disable-next-line zukhruf/no-promise-field -- A latch never rejects and is never replaced, so no hazard of the rule applies; it is the primitive the rule recommends.
  readonly #opened = Promise.withResolvers<{ value: T }>();

  /**
   * A later open changes nothing. A type that names a promise is refused: a
   * wait would adopt the promise, and could then reject.
   */
  open(value: T extends PromiseLike<unknown> ? never : T): void {
    this.#opened.resolve({ value });
  }

  wait(): Promise<T> {
    return this.#opened.promise.then(({ value }) => value);
  }
}
