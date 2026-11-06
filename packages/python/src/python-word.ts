// The characters of Python's \w in a str pattern, as the body of a RegExp
// class (u flag): letters, numbers and the underscore. The golden test proves
// it equal to CPython 3.12's for each code point that Python's Unicode
// database (15.0) assigns; Node knows characters of later Unicode versions,
// which it reads as \w and Python 3.12 does not.
export const PYTHON_WORD = String.raw`\p{L}\p{N}_`;
