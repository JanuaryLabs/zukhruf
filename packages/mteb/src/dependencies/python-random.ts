import { Random } from 'python-random';

// random.Random(seed) of CPython 3.12 for an int seed, from the npm package
// python-random, with the methods that MTEB calls over range(n).
export class PythonRandom {
  readonly #random: Random;

  constructor(seed: number) {
    this.#random = new Random(seed);
  }

  // sample(range(n), k).
  sample(n: number, k: number): number[] {
    return this.#random.sample(range(n), k);
  }

  // choices(range(n), k=k). python-random throws a RangeError for an empty
  // population where CPython raises the IndexError of range(0).
  choices(n: number, k: number): number[] {
    try {
      return this.#random.choices(range(n), { k });
    } catch (error) {
      if (
        error instanceof RangeError &&
        error.message === 'Cannot choose from an empty population'
      )
        throw new Error('IndexError: range object index out of range', {
          cause: error,
        });
      throw error;
    }
  }
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, index) => index);
}
