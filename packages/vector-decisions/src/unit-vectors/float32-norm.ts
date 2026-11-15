// The norm of a vector as one float32 number: computed in float64, then
// rounded, so it is the correctly rounded norm on every platform. Venn's
// float32 norm of one vector is the square root of a BLAS sdot (the read of
// the vector cache, venn/server.py:163, and the state of NearestReference,
// venn/server.py:968) or of PyTorch's vectorized norm kernel (F.normalize,
// venn/server.py:1095, venn/index/apply.py:63). The order of each sum
// depends on the platform: Accelerate or OpenBLAS, and 8 or 16 lanes by CPU
// (ADR 0007).
export function float32Norm(values: Iterable<number>): number {
  return Math.fround(Math.hypot(...values));
}
