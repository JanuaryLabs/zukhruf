// A vector whose dimension is not the dimension of the stored vectors: a
// vector of the model in an upsert, or a vector of the caller in a query.
export class DimensionMismatchError extends Error {
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number) {
    super(
      `The stored vectors have dimension ${expected}, and the new vector has dimension ${actual}. To change the model, upsert every document again with the new model, in one call. To query, give a vector of the model of the stored vectors.`,
    );
    this.name = 'DimensionMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}
