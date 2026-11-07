// The raw bits of a stream, as the bitgen_t of NumPy's C code gives them to
// each draw. A Generator draws from any bit generator (Bridge): the draws
// and the bits change apart.
export interface BitGenerator {
  // The next 32 bits of the stream, from 0 to 2^32 - 1.
  nextUint32(): number;
}
