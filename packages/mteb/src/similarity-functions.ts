import type { Embeddings } from './types/encoder-io.ts';

// mteb/similarity_functions.py: cos_sim and dot_score, and their pairwise
// forms. MTEB computes them with torch in float32. Each value here is the
// float32 nearest to the float64 product of the float32 inputs; a BLAS
// matrix product adds in another order, so a value can differ in its last
// float32 bit.

// torch.nn.functional.normalize(p=2, dim=1): each row divided by
// max(norm, 1e-12), in float32.
function normalize(embeddings: Embeddings): Float32Array[] {
  return embeddings.map((row) => {
    let squares = 0;
    for (const value of row) squares += value * value;
    const norm = Math.max(Math.fround(Math.sqrt(squares)), 1e-12);
    return row.map((value) => value / norm);
  });
}

function product(left: Embeddings, right: Embeddings): Float32Array[] {
  return left.map((row) =>
    Float32Array.from(right, (column) => {
      let sum = 0;
      for (let index = 0; index < row.length; index++)
        sum += (row[index] ?? 0) * (column[index] ?? 0);
      return sum;
    }),
  );
}

// The cosine similarity of each row of a with each row of b.
export function cosSim(a: Embeddings, b: Embeddings): Float32Array[] {
  return product(normalize(a), normalize(b));
}

// The dot product of each row of a with each row of b.
export function dotScore(a: Embeddings, b: Embeddings): Float32Array[] {
  return product(a, b);
}

// The cosine similarity of each row of a with the row of b at its index.
export function pairwiseCosSim(a: Embeddings, b: Embeddings): Float32Array {
  const left = normalize(a);
  const right = normalize(b);
  return Float32Array.from(
    left,
    (row, index) =>
      product([row], [right[index] ?? new Float32Array()])[0]?.[0] ?? 0,
  );
}

// The dot product of each row of a with the row of b at its index.
export function pairwiseDotScore(a: Embeddings, b: Embeddings): Float32Array {
  return Float32Array.from(
    a,
    (row, index) =>
      product([row], [b[index] ?? new Float32Array()])[0]?.[0] ?? 0,
  );
}
