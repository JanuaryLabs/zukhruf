// Joins the tokens of a tokenized corpus (ECB+, GVC) into text again. This
// is the detokenizer of research round #3130 (scripts/lead.ts), unchanged,
// so the texts are the texts that the round embedded. A URL run (a token
// "http", "https" or "www", then URL punctuation) is joined without spaces.
const URL_PUNCTUATION = /^[:/.\-_?=&#%~+,;@!]+$/u;

export function detokenize(tokens: readonly string[]): string {
  const out: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? '';
    const next = tokens[index + 1];
    if (
      /^(?:https?|www)$/iu.test(token) &&
      next !== undefined &&
      URL_PUNCTUATION.test(next)
    ) {
      let url = token;
      let end = index + 1;
      while (
        end < tokens.length &&
        (URL_PUNCTUATION.test(tokens[end] ?? '') ||
          URL_PUNCTUATION.test(tokens[end - 1] ?? ''))
      )
        url += tokens[end++] ?? '';
      out.push(url);
      index = end - 1;
      continue;
    }
    out.push(token);
  }
  return out
    .join(' ')
    .replace(/ ([.,;:!?%)\]}])/gu, '$1')
    .replace(/([([{$]) /gu, '$1')
    .replace(/ (n't|'s|'re|'ve|'ll|'d|'m)\b/giu, '$1')
    .replace(/" (.*?) "/gu, '"$1"');
}
