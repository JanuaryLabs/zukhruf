import type { Article } from '../src/index.ts';
import type { LoadedSet } from './slice.ts';

const DAY_MS = 86_400_000;

// The teaching window of a slice: the articles published in its first 14
// days (round 6, selection-rule.json "streams").
export function windowOf(slice: LoadedSet): boolean[] {
  const start = slice.set.metadata.sliceStart;
  if (start === undefined)
    throw new Error(`${slice.set.name} is not a slice of the feed.`);
  const cut = Date.parse(start) + 14 * DAY_MS;
  return slice.articles.map(({ publishedAt }) => publishedAt.getTime() < cut);
}

// The articles after the teaching window, which the design decides on, in
// the order of the slice.
export function scoredStream(
  slice: LoadedSet,
  window: readonly boolean[],
): [
  Article & { readonly id: string },
  ...(Article & { readonly id: string })[],
] {
  const [first, ...rest] = slice.articles
    .filter((_, index) => !window[index])
    .map(({ id, publishedAt }) => ({
      id,
      publishedAt,
      text: slice.textOf(id),
    }));
  if (first === undefined) throw new Error(`${slice.set.name} has no stream.`);
  return [first, ...rest];
}
