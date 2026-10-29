import type { BinormalFit } from './binormal.ts';
import { UnknownArticleError } from './errors.ts';
import type { PlattFit } from './platt.ts';

// How a calibrated filter turned the similarities into probabilities.
export type Calibration =
  | ({ readonly method: 'binormal' } & BinormalFit)
  // The binormal fit could not hold, so Platt's method on the taught scores
  // gave the probabilities (docs/adr/0002).
  | PlattFit;

// The decisions of a profile on one stream.
abstract class Decisions {
  readonly #probabilities: ReadonlyMap<string, number>;
  readonly #accepted: ReadonlySet<string>;

  constructor(
    probabilities: ReadonlyMap<string, number>,
    accepted: ReadonlySet<string>,
  ) {
    this.#probabilities = probabilities;
    this.#accepted = accepted;
  }

  // The probability that the article is relevant to the profile.
  probability(id: string): number {
    const probability = this.#probabilities.get(id);
    if (probability === undefined) throw new UnknownArticleError(id);
    return probability;
  }

  // True when the filter shows the article to the reader.
  accepts(id: string): boolean {
    if (!this.#probabilities.has(id)) throw new UnknownArticleError(id);
    return this.#accepted.has(id);
  }

  // The accepted articles, the most probable first. Equal probabilities keep
  // the order of the stream.
  accepted(): string[] {
    return [...this.#accepted].toSorted(
      (a, b) => this.probability(b) - this.probability(a),
    );
  }
}

// A filter that learned from at least one relevant answer. Its probabilities
// are calibrated, and it accepts the articles that maximise the expected
// F0.5.
export class CalibratedFilter extends Decisions {
  readonly kind = 'calibrated';
  readonly calibration: Calibration;
  // The lowest accepted probability. Undefined when nothing is accepted.
  readonly threshold: number | undefined;

  constructor(options: {
    readonly probabilities: ReadonlyMap<string, number>;
    readonly calibration: Calibration;
    readonly threshold: number | undefined;
  }) {
    const { probabilities, threshold } = options;
    super(
      probabilities,
      new Set(
        threshold === undefined
          ? []
          : [...probabilities]
              .filter(([, probability]) => probability >= threshold)
              .map(([id]) => id),
      ),
    );
    this.calibration = options.calibration;
    this.threshold = threshold;
  }
}

// A filter with no relevant answer to learn from. It accepts the articles
// that match a keyword of the profile: the probability is 1 for a match and
// 0 for the others, and it is not calibrated.
export class KeywordFilter extends Decisions {
  readonly kind = 'keywords';

  constructor(matches: ReadonlyMap<string, boolean>) {
    super(
      new Map([...matches].map(([id, match]) => [id, match ? 1 : 0])),
      new Set([...matches].filter(([, match]) => match).map(([id]) => id)),
    );
  }
}

export type RelevanceFilter = CalibratedFilter | KeywordFilter;
