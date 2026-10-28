import type { Design } from './design.ts';

type Rule = Design['lead'];

// The title and the first real sentences of a report. News puts the main
// facts first, so the lead holds most of the event.
export type Lead = {
  // Null when the report has no title and no real sentence.
  readonly title: string | null;
  readonly sentences: readonly string[];
};

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

// A report without a title takes its first real sentence as the title.
export function leadOf(title: string, body: string, rule: Rule): Lead {
  const real = realSentences(body, title, rule);
  const resolved = title ? clean(title) : (real.shift() ?? null);
  return { title: resolved, sentences: real.slice(0, rule.sentences) };
}

// The real sentences of a body, in order, without their URLs. A sentence that
// starts with the title loses that prefix.
function realSentences(body: string, title: string, rule: Rule): string[] {
  const prefix = title ? clean(title).toLowerCase() : null;
  const sentences: string[] = [];
  for (const { segment } of segmenter.segment(body)) {
    let sentence = clean(segment);
    if (!isReal(sentence, rule)) continue;
    sentence = clean(sentence.replace(urls(rule), ' '));
    if (prefix !== null && sentence.toLowerCase().startsWith(prefix))
      sentence = clean(sentence.slice(prefix.length));
    if (sentence && isReal(sentence, rule)) sentences.push(sentence);
  }
  return sentences;
}

// A segment is a real sentence when URLs are at most half of its characters,
// and the rest has enough words and is mostly letters. Blank lines, captions,
// bylines and URL lines are not real sentences.
function isReal(segment: string, rule: Rule): boolean {
  const compact = segment.replace(/\s+/gu, '');
  if (!compact) return false;
  const urlCharacters = (compact.match(urls(rule)) ?? []).reduce(
    (sum, url) => sum + url.length,
    0,
  );
  if (urlCharacters / compact.length > rule.maxUrlShare) return false;
  const rest = segment.replace(urls(rule), ' ');
  if ((rest.match(/\p{L}[\p{L}\p{M}'’-]*/gu) ?? []).length < rule.minWords)
    return false;
  const characters = rest.replace(/\s/gu, '');
  const letters = (rest.match(/\p{L}/gu) ?? []).length;
  return letters / characters.length >= rule.minLetterRatio;
}

function clean(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

// A new expression for each use, because a global expression keeps its
// lastIndex.
function urls(rule: Rule): RegExp {
  return new RegExp(rule.urlPattern, 'giu');
}
