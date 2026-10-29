// A keyword that the reader types. A string matches at the start of a word,
// in any case: "secur" matches "Security" and "securing", but not
// "cybersecurity". A regular expression matches as it is (docs/adr/0003).
export type Keyword = string | RegExp;

// True when one keyword of the list is in the text.
export function matchesAny(
  keywords: readonly Keyword[],
  text: string,
): boolean {
  return keywords.some((keyword) => text.search(patternOf(keyword)) !== -1);
}

function patternOf(keyword: Keyword): RegExp {
  if (keyword instanceof RegExp) return keyword;
  const escaped = keyword.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}`, 'iu');
}
