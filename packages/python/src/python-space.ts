// The characters of Python's str.isspace(), which are also its \s and the
// separators of str.split(), as the body of a RegExp class (u flag): a probe
// over every code point proved it equal to CPython 3.12's. It differs from
// JavaScript's \s: it has U+001C to U+001F and lacks U+FEFF.
export const PYTHON_SPACE = String.raw`\t\n\v\f\r\x1c-\x1f \x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}`;
