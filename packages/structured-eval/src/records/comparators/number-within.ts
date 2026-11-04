import type { Comparator } from '../comparator.ts';

export class NumberWithin implements Comparator {
  readonly #tolerance: number;

  constructor(tolerance: number) {
    this.#tolerance = tolerance;
  }

  agrees(stated: unknown, expected: unknown): boolean {
    return (
      typeof stated === 'number' &&
      typeof expected === 'number' &&
      Math.abs(stated - expected) <= this.#tolerance
    );
  }
}
