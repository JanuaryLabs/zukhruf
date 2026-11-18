import { DimensionMismatchError } from './dimension-mismatch-error.ts';
import { elements } from './elements.ts';
import type { BitVector, HalfVector, Int8Vector, Vector } from './vector.ts';

type NumericVector = Vector | HalfVector | Int8Vector;

/** The dot product, in float64. */
export function dot<T extends NumericVector>(a: T, b: T): number {
  const [x, y] = pair(a, b);
  let sum = 0;
  for (let index = 0; index < x.length; index++) {
    sum += (x[index] ?? 0) * (y[index] ?? 0);
  }
  return sum;
}

/** The length of the vector, in float64. */
export function norm(a: NumericVector): number {
  let squares = 0;
  for (const value of a[elements]) squares += value * value;
  return Math.sqrt(squares);
}

/** The cosine of the angle between the vectors. `NaN` when one of them has length 0. */
export function cosineSimilarity<T extends NumericVector>(a: T, b: T): number {
  return dot(a, b) / (norm(a) * norm(b));
}

/** 1 − the cosine similarity: 0 for one direction, 1 for orthogonal, 2 for opposite. */
export function cosineDistance<T extends NumericVector>(a: T, b: T): number {
  return 1 - cosineSimilarity(a, b);
}

/** The L2 distance, in float64. */
export function euclideanDistance<T extends NumericVector>(a: T, b: T): number {
  const [x, y] = pair(a, b);
  let squares = 0;
  for (let index = 0; index < x.length; index++) {
    const difference = (x[index] ?? 0) - (y[index] ?? 0);
    squares += difference * difference;
  }
  return Math.sqrt(squares);
}

/** The number of bits that differ. */
export function hammingDistance(a: BitVector, b: BitVector): number {
  const [x, y] = pair(a, b);
  let differ = 0;
  for (let index = 0; index < x.length; index++) {
    let bits = (x[index] ?? 0) ^ (y[index] ?? 0);
    while (bits !== 0) {
      differ += bits & 1;
      bits >>= 1;
    }
  }
  return differ;
}

function pair<T extends NumericVector | BitVector>(
  a: T,
  b: T,
): [ArrayLike<number>, ArrayLike<number>] {
  if (a.dimensions !== b.dimensions) {
    throw new DimensionMismatchError(a.dimensions, b.dimensions);
  }
  return [a[elements], b[elements]];
}
