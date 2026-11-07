// UTF-16 code units order the strings that have no character above U+FFFF
// as code points do.
const SURROGATE = /[\u{10000}-\u{10FFFF}]/u;

// Compares two strings as Python does: by Unicode code point, so
// sorted(strings) of Python is strings.toSorted(compareStrings). UTF-8 bytes,
// which C's strcmp compares, have the same order.
export function compareStrings(left: string, right: string): number {
  if (!SURROGATE.test(left) && !SURROGATE.test(right))
    return left < right ? -1 : left > right ? 1 : 0;
  const a = [...left];
  const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference =
      (a[index]?.codePointAt(0) ?? 0) - (b[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}
