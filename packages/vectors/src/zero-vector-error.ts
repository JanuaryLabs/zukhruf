/** A vector of length 0 has no direction, so it has no unit vector. */
export class ZeroVectorError extends Error {
  override readonly name = 'ZeroVectorError';

  constructor() {
    super('A vector of length 0 has no unit vector');
  }
}
