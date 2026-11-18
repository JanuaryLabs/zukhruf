// The typed array of a vector, for the functions of this package only. The
// index does not export these symbols, so a caller reads `values`, a copy, and
// cannot change a vector, a unit vector included.
export const elements: unique symbol = Symbol('@zukhruf/vectors elements');

// Makes a vector of an array that the package already checked or read from a
// SQL form, with no copy.
export const fromElements: unique symbol = Symbol(
  '@zukhruf/vectors fromElements',
);
