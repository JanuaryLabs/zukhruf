import { TypedComparator } from './typed-comparator.ts';

export class NumberWithin extends TypedComparator<number> {
  readonly #tolerance: number;

  constructor(tolerance: number) {
    super();
    this.#tolerance = tolerance;
  }

  protected accepts(value: unknown): value is number {
    return typeof value === 'number';
  }

  protected compare(stated: number, expected: number): boolean {
    return Math.abs(stated - expected) <= this.#tolerance;
  }
}
