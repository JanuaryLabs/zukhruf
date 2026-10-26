// The model gave a vector whose dimension is not the dimension of the vectors
// that the collection stores.
export class DimensionMismatchError extends Error {
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number) {
    super(
      `The collection stores vectors of dimension ${expected}, and the model gave a vector of dimension ${actual}. Upsert every document again with the new model, in one call.`,
    );
    this.name = 'DimensionMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}
