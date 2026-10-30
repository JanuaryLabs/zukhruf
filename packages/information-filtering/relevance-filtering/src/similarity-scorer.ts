import { binormal } from './binormal.ts';
import { withKeywordEvidence } from './evidence.ts';
import { type Keyword, matchesAny } from './keyword.ts';
import { platt, plattProbability } from './platt.ts';
import type { Scorer, Stream } from './scorer.ts';
import { Scores, compareIds } from './scores.ts';
import { keywordRanking, similarities } from './similar.ts';
import type { TaughtAnswers } from './taught-answers.ts';
import type { Vectors } from './vectors.ts';

// The frozen design of research round 6 (docs/adr/0002) for one interest:
// the similarity of each article to the description, calibrated by a
// binormal model on the stream and the answers, or by Platt's method on the
// answers, with the evidence of the keywords. When neither fit can hold, the
// keyword matches come first.
export class SimilarityScorer implements Scorer {
  readonly #vectors: Vectors;
  readonly #descriptionVector: readonly number[];
  readonly #answers: TaughtAnswers;
  readonly #keywords: readonly Keyword[];

  constructor(options: {
    // The vectors of the stream and of the taught articles.
    readonly vectors: Vectors;
    // The vector of the description, from the model of the stored vectors,
    // with the prompt that the model uses for a query (docs/adr/0002).
    readonly descriptionVector: readonly number[];
    readonly answers: TaughtAnswers;
    readonly keywords: readonly Keyword[];
  }) {
    this.#vectors = options.vectors;
    this.#descriptionVector = options.descriptionVector;
    this.#answers = options.answers;
    this.#keywords = options.keywords;
  }

  async score(
    stream: Stream,
    { signal }: { readonly signal: AbortSignal },
  ): Promise<Scores> {
    signal.throwIfAborted();
    if (stream.size === 0) return new Scores(new Map());
    const similar = similarities(
      this.#vectors,
      this.#descriptionVector,
      stream,
      this.#keywords,
    );
    const scores = similar.map(({ similarity }) => similarity);
    const taught = this.#taughtScores();
    let probabilities = binormal(scores, taught.relevant, taught.notRelevant);
    if (probabilities === undefined && this.#answers.notRelevant.length > 0) {
      const fit = platt(taught.relevant, taught.notRelevant);
      probabilities = scores.map((score) => plattProbability(fit, score));
    }
    if (probabilities === undefined) return keywordRanking(similar);
    if (this.#keywords.length > 0)
      probabilities = withKeywordEvidence(
        probabilities,
        similar.map(({ match }) => match),
        this.#answers.relevant.map(({ text }) =>
          matchesAny(this.#keywords, text),
        ),
      );
    const scored = similar.map((article, index) => ({
      ...article,
      probability: probabilities[index] ?? 0,
    }));
    return new Scores(
      new Map(
        scored
          .toSorted(
            (a, b) =>
              b.probability - a.probability ||
              b.similarity - a.similarity ||
              compareIds(a.id, b.id),
          )
          .map(({ id, publishedAt, probability }) => [
            id,
            { publishedAt, probability },
          ]),
      ),
    );
  }

  // The cosine of the description with each taught article: the dot product
  // of the stored unit vector and the description made a unit vector.
  #taughtScores() {
    const { relevant, notRelevant } = this.#answers;
    const description = this.#descriptionVector;
    const length = Math.hypot(...description);
    const stored = this.#vectors.fetch(
      [...relevant, ...notRelevant].map(({ id }) => id),
    );
    const score = ({ id }: { readonly id: string }) => {
      const vector = stored.get(id) ?? [];
      let total = 0;
      for (let index = 0; index < description.length; index++)
        total += (vector[index] ?? 0) * ((description[index] ?? 0) / length);
      return total;
    };
    return {
      relevant: relevant.map(score),
      notRelevant: notRelevant.map(score),
    };
  }
}
