/** Two vectors of one call have other dimensions, for example the vectors of two models. */
export class DimensionMismatchError extends Error {
  override readonly name = 'DimensionMismatchError';
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number) {
    super(`The vectors have other dimensions: ${expected} and ${actual}`);
    this.expected = expected;
    this.actual = actual;
  }
}
