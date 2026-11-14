// A vector has another number of values than the head reads, as a vector of
// another reader has.
export class DimensionMismatchError extends Error {
  constructor(vector: string, actual: number, expected: number) {
    super(
      `The ${vector} has ${actual} numbers, but the head reads ${expected}.`,
    );
    this.name = 'DimensionMismatchError';
  }
}
