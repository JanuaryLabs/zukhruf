import { Vector } from '@zukhruf/vectors';

// Divides each value by the length of the embedding, in float64, and rounds
// once to float32. The result is a unit vector, so its dot product with
// another one is their cosine similarity. It is not UnitVector.normalize of
// @zukhruf/vectors: a length of zero, or one that is not finite, is a
// RangeError for the callers of a collection (that normalize throws
// ZeroVectorError), and that normalize rounds each value to float32 before it
// divides, which can change a stored vector in the last bit.
export function normalize(values: readonly number[]): Vector {
  const length = Math.sqrt(
    values.reduce((sum, value) => sum + value * value, 0),
  );
  if (length === 0 || !Number.isFinite(length))
    throw new RangeError(
      `An embedding must have a finite length that is not zero. Its length is ${length}.`,
    );
  return Vector.from(Float32Array.from(values, (value) => value / length));
}

// The value of a vector column, which SQLite gives as a Uint8Array.
export function blob(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array))
    throw new TypeError('A stored vector must be a BLOB.');
  return value;
}
