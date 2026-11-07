import type { LeafValue } from '../leaf-pair.ts';
import { TypedComparator } from './typed-comparator.ts';

// Two numbers agree when they differ by at most the tolerance. An int and a
// float compare as JavaScript numbers, so an int past 2^53 loses its last
// digits.
export class NumberWithin extends TypedComparator<bigint | number> {
  readonly #tolerance: number;

  constructor(tolerance: number) {
    super();
    this.#tolerance = tolerance;
  }

  protected accepts(value: LeafValue): value is bigint | number {
    return typeof value === 'bigint' || typeof value === 'number';
  }

  protected compare(stated: bigint | number, expected: bigint | number) {
    return Math.abs(Number(stated) - Number(expected)) <= this.#tolerance;
  }
}
