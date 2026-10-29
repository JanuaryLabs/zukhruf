import type { BinormalFit } from './binormal.ts';
import { UnknownArticleError } from './errors.ts';
import type { PlattFit } from './platt.ts';

// How a calibrated filter turned the similarities into probabilities.
export type Calibration =
  | ({ readonly method: 'binormal' } & BinormalFit)
  // The binormal fit could not hold, so Platt's method on the taught scores
  // gave the probabilities (docs/adr/0002).
  | PlattFit;

// An article of the stream as the filter ranks it.
export type RankedArticle = {
  readonly id: string;
  readonly publishedAt: Date;
  // The similarity of the article to the description.
  readonly similarity: number;
};

// A publish range of the stream, the edges included, for example one day.
export type PublishRange = { readonly from: Date; readonly to: Date };

// The decisions of a profile on one stream.
abstract class Decisions {
  readonly #probabilities: ReadonlyMap<string, number>;
  readonly #accepted: ReadonlySet<string>;
  readonly #order: readonly RankedArticle[];

  constructor(options: {
    readonly probabilities: ReadonlyMap<string, number>;
    readonly accepted: ReadonlySet<string>;
    readonly order: readonly RankedArticle[];
  }) {
    this.#probabilities = options.probabilities;
    this.#accepted = options.accepted;
    this.#order = options.order;
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
        ? this.#order
        : this.#order.filter(
            ({ publishedAt }) =>
              publishedAt >= range.from && publishedAt <= range.to,
          );
    return inRange.map(({ id }) => id);
  }

  // True when the expected-F0.5 threshold accepts the article. Not
  // recommended for decisions: use ranked (docs/adr/0004).
  accepts(id: string): boolean {
    if (!this.#probabilities.has(id)) throw new UnknownArticleError(id);
    return this.#accepted.has(id);
  }

  // The accepted articles, the most probable first. Equal probabilities keep
  // the order of the stream. Not recommended for decisions: use ranked
  // (docs/adr/0004).
  accepted(): string[] {
    return [...this.#accepted].toSorted(
      (a, b) => this.probability(b) - this.probability(a),
    );
  }
}

// A filter that learned from at least one relevant answer. Its probabilities
// are calibrated. It ranks by probability, then by similarity, then by id.
export class CalibratedFilter extends Decisions {
  readonly kind = 'calibrated';
  readonly calibration: Calibration;
  // The lowest probability that the expected-F0.5 threshold accepts.
  // Undefined when nothing is accepted.
  readonly threshold: number | undefined;

  constructor(options: {
    readonly stream: readonly RankedArticle[];
    readonly probabilities: ReadonlyMap<string, number>;
    readonly calibration: Calibration;
    readonly threshold: number | undefined;
  }) {
    const { stream, probabilities, threshold } = options;
    const probability = (id: string) => probabilities.get(id) ?? 0;
    super({
      probabilities,
      accepted: new Set(
        threshold === undefined
          ? []
          : [...probabilities]
              .filter(([, value]) => value >= threshold)
              .map(([id]) => id),
      ),
      order: stream.toSorted(
        (a, b) =>
          probability(b.id) - probability(a.id) ||
          b.similarity - a.similarity ||
          compareIds(a.id, b.id),
      ),
    });
    this.calibration = options.calibration;
    this.threshold = threshold;
  }
}

// A filter with no relevant answer to learn from. It accepts the articles
// that match a keyword of the profile: the probability is 1 for a match and
// 0 for the others, and it is not calibrated. It ranks the matches first,
// the newest first, and then the other articles by similarity.
export class KeywordFilter extends Decisions {
  readonly kind = 'keywords';

  constructor(options: {
    readonly stream: readonly RankedArticle[];
    readonly matches: ReadonlyMap<string, boolean>;
  }) {
    const { stream, matches } = options;
    const match = (id: string) => matches.get(id) ?? false;
    super({
      probabilities: new Map(
        [...matches].map(([id, value]) => [id, value ? 1 : 0]),
      ),
      accepted: new Set(
        [...matches].filter(([, value]) => value).map(([id]) => id),
      ),
      order: stream.toSorted((a, b) => {
        if (match(a.id) !== match(b.id)) return match(a.id) ? -1 : 1;
        const key = match(a.id)
          ? b.publishedAt.getTime() - a.publishedAt.getTime()
          : b.similarity - a.similarity;
        return key || compareIds(a.id, b.id);
      }),
    });
  }
}

export type RelevanceFilter = CalibratedFilter | KeywordFilter;

// Compares by code unit, not by locale, so the order is the same on every
// machine.
function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
