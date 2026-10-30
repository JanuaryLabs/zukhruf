// ddot of BLAS, where SciPy and scikit-learn call the BLAS of the platform:
// the float64 dot product of n values of x from offsetX and of y from
// offsetY. It adds in index order. Accelerate and OpenBLAS add in blocks of
// their own, so a sum can differ in its last bits.
export function ddot(
  n: number,
  x: ArrayLike<number>,
  offsetX: number,
  y: ArrayLike<number>,
  offsetY: number,
): number {
  let total = 0;
  for (let i = 0; i < n; i++)
    total += (x[offsetX + i] ?? 0) * (y[offsetY + i] ?? 0);
  return total;
}
