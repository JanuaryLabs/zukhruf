import type { Keyword } from './keyword.ts';
import type { Scorer, Stream } from './scorer.ts';
import { Scores } from './scores.ts';
import { keywordRanking, similarities } from './similar.ts';
import type { Vectors } from './vectors.ts';

// The cold start of the frozen design (docs/adr/0002) for one interest that
// has no yes answer yet: the articles that match a keyword come first, the
// newest first, and then the other articles by similarity.
export class KeywordScorer implements Scorer {
  readonly #vectors: Vectors;
  readonly #descriptionVector: readonly number[];
  readonly #keywords: readonly [Keyword, ...Keyword[]];

  constructor(options: {
    // The vectors of the stream.
    readonly vectors: Vectors;
    // The vector of the description, from the model of the stored vectors,
    // with the prompt that the model uses for a query.
    readonly descriptionVector: readonly number[];
    readonly keywords: readonly [Keyword, ...Keyword[]];
  }) {
    this.#vectors = options.vectors;
    this.#descriptionVector = options.descriptionVector;
    this.#keywords = options.keywords;
  }

  async score(stream: Stream): Promise<Scores> {
    if (stream.size === 0) return new Scores(new Map());
    return keywordRanking(
      similarities(
        this.#vectors,
        this.#descriptionVector,
        stream,
        this.#keywords,
      ),
    );
  }
}
