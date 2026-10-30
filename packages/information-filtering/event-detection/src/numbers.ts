// The numbers and version-like tokens of a text, such as "4.5", "rc1", "v14",
// "143,000" and "2017". A thousands separator and a leading "v" go away, so
// "143,000" is "143000" and "v14" is "14".
export function numbersOf(text: string): Set<string> {
  const numbers = new Set<string>();
  for (const [match] of text
    .toLowerCase()
    .matchAll(/[a-z]*\d[\d.,]*[a-z\d]*/gu)) {
    let token = match
      .replace(/[.,]+$/u, '')
      .replace(/(\d),(?=\d{3}\b)/gu, '$1');
    if (/^v\d/u.test(token)) token = token.slice(1);
    if (token) numbers.add(token);
  }
  return numbers;
}
