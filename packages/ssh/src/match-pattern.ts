/** OpenSSH's `match_pattern` (match.c): `*` matches any run of characters, and `?` one character, with case. */
export function matchPattern(pattern: string, name: string): boolean {
  if (pattern === '') return name === '';
  const [first] = pattern;
  if (first === '*') {
    for (let start = 0; start <= name.length; start++) {
      if (matchPattern(pattern.slice(1), name.slice(start))) return true;
    }
    return false;
  }
  if (name === '') return false;
  return (
    (first === '?' || first === name[0]) &&
    matchPattern(pattern.slice(1), name.slice(1))
  );
}
