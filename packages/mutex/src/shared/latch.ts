/**
 * A gate that starts closed and opens once. It never closes again, so a wait
 * that starts after it opened ends at once.
 */
export class Latch {
  readonly #opened = Promise.withResolvers<void>();

  open(): void {
    this.#opened.resolve();
  }

  wait(): Promise<void> {
    return this.#opened.promise;
  }
}
