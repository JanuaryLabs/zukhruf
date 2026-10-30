import { UnknownArticleError } from './errors.ts';
import type { Profile } from './profile.ts';
import type { Threshold } from './threshold.ts';

// A publish range of the stream, the edges included, for example one day.
export type PublishRange = { readonly from: Date; readonly to: Date };

// An article of the stream with the probability that a scorer gave it.
export type ScoredArticle = {
  readonly id: string;
  readonly publishedAt: Date;
  readonly probability: number;
};

// What a scorer gives for one profile and one stream: the articles, the best
// first, each with its probability (docs/adr/0005).
export class Scores {
  readonly #profile: Profile;
  readonly #ranked: readonly ScoredArticle[];
  readonly #probabilities: ReadonlyMap<string, number>;

  // `ranked` is the stream in the order of the scorer, the best first.
  constructor(options: {
    readonly profile: Profile;
    readonly ranked: readonly ScoredArticle[];
  }) {
    const { profile, ranked } = options;
    const probabilities = new Map(
      ranked.map(({ id, probability }) => [id, probability]),
    );
    if (probabilities.size !== ranked.length)
      throw new RangeError('Each article of the stream must have its own id.');
    this.#profile = profile;
    this.#ranked = ranked;
    this.#probabilities = probabilities;
  }

  // The probability that the article is relevant to the profile.
  probability(id: string): number {
    const probability = this.#probabilities.get(id);
    if (probability === undefined) throw new UnknownArticleError(id);
    return probability;
  }

  // The ids of the stream, the best first (docs/adr/0004). With a range, only
  // the articles published in it, in the same order: the best N of a day are
  // ranked({ from, to }).slice(0, n).
  ranked(range?: PublishRange): string[] {
    const inRange =
      range === undefined
        ? this.#ranked
        : this.#ranked.filter(
            ({ publishedAt }) =>
              publishedAt >= range.from && publishedAt <= range.to,
          );
    return inRange.map(({ id }) => id);
  }

  // The articles that the threshold accepts, in the order of ranked().
  accepted(threshold: Threshold): string[] {
    const cut = threshold.cut(this, this.#profile);
    return this.#ranked
      .filter(({ probability }) => probability >= cut)
      .map(({ id }) => id);
  }
}

// Compares by code unit, not by locale, so the order is the same on every
// machine.
export function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
