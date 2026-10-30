import { UnknownArticleError } from './errors.ts';
import type { Threshold } from './threshold.ts';

// A publish range of the stream, the edges included, for example one day.
export type PublishRange = { readonly from: Date; readonly to: Date };

// An article of the stream with the probability that a scorer gave it.
export type ScoredArticle = {
  readonly publishedAt: Date;
  readonly probability: number;
};

// What a scorer gives for one stream: the articles by id, the best first,
// each with its probability (docs/adr/0005).
export class Scores {
  readonly #ranked: ReadonlyMap<string, ScoredArticle>;

  // `ranked` is the stream in the order of the scorer, the best first.
  constructor(ranked: ReadonlyMap<string, ScoredArticle>) {
    this.#ranked = ranked;
  }

  // The probability that the article is relevant to the interest.
  probability(id: string): number {
    const article = this.#ranked.get(id);
    if (article === undefined) throw new UnknownArticleError(id);
    return article.probability;
  }

  // The ids of the stream, the best first (docs/adr/0004). With a range, only
  // the articles published in it, in the same order: the best N of a day are
  // ranked({ from, to }).slice(0, n).
  ranked(range?: PublishRange): string[] {
    return [...this.#ranked]
      .filter(
        ([, { publishedAt }]) =>
          range === undefined ||
          (publishedAt >= range.from && publishedAt <= range.to),
      )
      .map(([id]) => id);
  }

  // The articles that the threshold accepts, in the order of ranked().
  accepted(threshold: Threshold): string[] {
    const cut = threshold.cut(this);
    return [...this.#ranked]
      .filter(([, { probability }]) => probability >= cut)
      .map(([id]) => id);
  }
}

// Compares by code unit, not by locale, so the order is the same on every
// machine.
export function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
