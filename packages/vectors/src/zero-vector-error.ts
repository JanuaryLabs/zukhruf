/**
 * A vector of length 0 has no direction, so it has no unit vector. It is a
 * RangeError, as the other value errors of the package are (ADR 0003).
 */
export class ZeroVectorError extends RangeError {
  override readonly name = 'ZeroVectorError';

  constructor() {
    super('A vector of length 0 has no unit vector');
  }
}
