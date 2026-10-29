import type { Design } from './design.ts';

type Rule = Design['lead'];

// The title and the first real sentences of a report. News puts the main
// facts first, so the lead holds most of the event.
export type Lead = {
  // Null when the report has no title and no real sentence.
  readonly title: string | null;
  readonly sentences: readonly string[];
};

// True for the key of a segment that the publisher repeats in its reports
// (src/templates.ts).
export type IsTemplate = (key: string) => boolean;

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const none: IsTemplate = () => false;

// A report without a title takes its first real sentence as the title.
export function leadOf(
  title: string,
  body: string,
  rule: Rule,
  isTemplate: IsTemplate = none,
): Lead {
  const real = realSentences(body, title, rule, isTemplate);
  const resolved = title ? clean(title) : (real.shift() ?? null);
  return { title: resolved, sentences: real.slice(0, rule.sentences) };
}

// The segments of a body, in order, each with its key: the segment in lower
// case, with one space between words. With a clean rule, the URLs go away
// before the sentence split, so a "?" or a "." in a URL splits no sentence.
export function segmentsOf(
  body: string,
  rule: Rule,
): { readonly segment: string; readonly key: string }[] {
  const text = rule.clean === undefined ? body : body.replace(urls(rule), ' ');
  return [...segmenter.segment(text)].flatMap(({ segment }) => {
    const key = clean(segment).toLowerCase();
    return key ? [{ segment, key }] : [];
  });
}

// The text that the numbers of a report come from: the title and the body.
// With a clean rule, the URLs and the template segments are not in it.
export function numberText(
  title: string,
  body: string,
  rule: Rule,
  isTemplate: IsTemplate = none,
): string {
  if (rule.clean === undefined) return `${title}\n${body}`;
  const kept = segmentsOf(body, rule)
    .filter(({ key }) => !isTemplate(key))
    .map(({ segment }) => segment);
  return `${title}\n${kept.join(' ')}`;
}

// The real sentences of a body, in order, without their URLs and without the
// template segments of its publisher. A sentence that starts with the title
// loses that prefix.
function realSentences(
  body: string,
  title: string,
  rule: Rule,
  isTemplate: IsTemplate,
): string[] {
  const prefix = title ? clean(title).toLowerCase() : null;
  const sentences: string[] = [];
  for (const { segment, key } of segmentsOf(body, rule)) {
    if (isTemplate(key)) continue;
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
