// scipy.linalg.lstsq(a, b, cond) of SciPy 1.18.1 with its default driver,
// LAPACK gelsd, for a 1-D b: the minimum-norm solution x of min |b - a x|,
// where a singular value s_i <= cond * s_0 counts as 0. The singular value
// decomposition is the one of ml-matrix (Golub-Kahan-Reinsch, in float64),
// not the divide and conquer of gelsd, and SciPy calls the float32 sgelsd of
// the platform's LAPACK for float32 data. Thus x has the same rank and cut,
// but can differ in its last float32 bits. residues has no caller here.
import { Matrix, SingularValueDecomposition } from 'ml-matrix';

export type LeastSquares = {
  // The solution, in float64.
  readonly x: Float64Array;
  // The number of singular values above cond * s_0.
  readonly rank: number;
  // The singular values of a, from the largest.
  readonly s: Float64Array;
};

export function lstsq(
  a: readonly ArrayLike<number>[],
  b: ArrayLike<number>,
  cond: number,
): LeastSquares {
  const matrix = new Matrix(a.map((row) => Array.from(row)));
  // Without autoTranspose, the decomposition of ml-matrix is wrong for fewer
  // rows than columns.
  const svd = new SingularValueDecomposition(matrix, { autoTranspose: true });
  const s = Float64Array.from(svd.diagonal);
  const u = svd.leftSingularVectors;
  const v = svd.rightSingularVectors;
  const cut = cond * (s[0] ?? 0);
  const rank = s.filter((value) => value > cut).length;
  const x = new Float64Array(matrix.columns);
  for (const [i, value] of s.subarray(0, rank).entries()) {
    let projection = 0;
    for (let row = 0; row < matrix.rows; row++)
      projection += u.get(row, i) * (b[row] ?? 0);
    const scale = projection / value;
    for (let column = 0; column < x.length; column++)
      x[column] = (x[column] ?? 0) + scale * v.get(column, i);
  }
  return { x, rank, s };
}
