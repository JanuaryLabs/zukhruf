import { binormal } from './binormal.ts';
import { MissingVectorError, NoEvidenceError } from './errors.ts';
import { withKeywordEvidence } from './evidence.ts';
import { matchesAny } from './keyword.ts';
import { platt, plattProbability } from './platt.ts';
import type { Profile } from './profile.ts';
import type { Scorer, Stream } from './scorer.ts';
import { Scores, compareIds } from './scores.ts';
import type { Vectors } from './vectors.ts';

type SimilarityScorerOptions = {
  // The vectors of the stream and of the taught articles.
  readonly vectors: Vectors;
  // The vector of a description, from the model of the stored vectors, with
  // the prompt that the model uses for a query (docs/adr/0002).
  readonly embedDescription: (
    description: string,
  ) => Promise<readonly number[]>;
  // The text of a taught relevant article, which the keywords are matched
  // in. It is asked only when the profile has keywords.
  readonly taughtText: (id: string) => string;
};

// An article of the stream with its similarity to the description, and if
// it matches a keyword of the profile.
type Similar = {
  readonly id: string;
  readonly publishedAt: Date;
  readonly similarity: number;
  readonly match: boolean;
};

// The frozen design of research round 6 (docs/adr/0002): the similarity of
// each article to the description, calibrated by a binormal model on the
// stream and the answers, or by Platt's method on the answers, with the
// evidence of the keywords. A profile with no relevant answer ranks the
// keyword matches first.
export class SimilarityScorer implements Scorer {
  readonly #options: SimilarityScorerOptions;

  constructor(options: SimilarityScorerOptions) {
    this.#options = options;
  }

  async score(profile: Profile, stream: Stream): Promise<Scores> {
    const descriptionVector = await this.#options.embedDescription(
      profile.description,
    );
    const similar = streamScores(
      this.#options.vectors,
      descriptionVector,
      stream,
      profile,
    );
    if (profile.relevant.length === 0) return keywordScores(profile, similar);
    const scores = similar.map(({ similarity }) => similarity);
    const taught = taughtScores(
      this.#options.vectors,
      descriptionVector,
      profile,
    );
    let probabilities = binormal(scores, taught.relevant, taught.notRelevant);
    if (probabilities === undefined && profile.notRelevant.length > 0) {
      const fit = platt(taught.relevant, taught.notRelevant);
      probabilities = scores.map((score) => plattProbability(fit, score));
    }
    if (probabilities === undefined) return keywordScores(profile, similar);
    if (profile.keywords.length > 0)
      probabilities = withKeywordEvidence(
        probabilities,
        similar.map(({ match }) => match),
        profile.relevant.map((id) =>
          matchesAny(profile.keywords, this.#options.taughtText(id)),
        ),
      );
    const scored = similar.map((article, index) => ({
      ...article,
      probability: probabilities[index] ?? 0,
    }));
    return new Scores({
      profile,
      ranked: scored
        .toSorted(
          (a, b) =>
            b.probability - a.probability ||
            b.similarity - a.similarity ||
            compareIds(a.id, b.id),
        )
        .map(({ id, publishedAt, probability }) => ({
          id,
          publishedAt,
          probability,
        })),
    });
  }
}

// A profile with no relevant answer to learn from: the probability is 1 for
// a keyword match and 0 for the others, and it is not calibrated. The
// matches come first, the newest first, and then the other articles by
// similarity.
function keywordScores(profile: Profile, similar: readonly Similar[]): Scores {
  if (profile.keywords.length === 0) throw new NoEvidenceError(profile.name);
  return new Scores({
    profile,
    ranked: similar
      .toSorted((a, b) => {
        if (a.match !== b.match) return a.match ? -1 : 1;
        const key = a.match
          ? b.publishedAt.getTime() - a.publishedAt.getTime()
          : b.similarity - a.similarity;
        return key || compareIds(a.id, b.id);
      })
      .map(({ id, publishedAt, match }) => ({
        id,
        publishedAt,
        probability: match ? 1 : 0,
      })),
  });
}

// Each article of the stream, in the order of the stream, with its
// similarity to the description from one query over the publish dates of
// the stream, and its keyword match.
function streamScores(
  vectors: Vectors,
  descriptionVector: readonly number[],
  stream: Stream,
  { keywords }: Profile,
): Similar[] {
  const dates = stream.map(({ publishedAt }) => publishedAt.getTime());
  const similarities = new Map(
    vectors
      .query(descriptionVector, {
        from: new Date(dates.reduce((a, b) => Math.min(a, b))),
        to: new Date(dates.reduce((a, b) => Math.max(a, b))),
      })
      .map(({ id, similarity }) => [id, similarity]),
  );
  return stream.map(({ id, publishedAt, text }) => {
    const similarity = similarities.get(id);
    if (similarity === undefined) throw new MissingVectorError(id);
    return { id, publishedAt, similarity, match: matchesAny(keywords, text) };
  });
}

// The cosine of the description with each taught article: the dot product
// of the stored unit vector and the description made a unit vector.
function taughtScores(
  vectors: Vectors,
  descriptionVector: readonly number[],
  { relevant, notRelevant }: Profile,
) {
  const length = Math.hypot(...descriptionVector);
  const stored = vectors.fetch([...relevant, ...notRelevant]);
  const score = (id: string) => {
    const vector = stored.get(id) ?? [];
    let total = 0;
    for (let index = 0; index < descriptionVector.length; index++)
      total +=
        (vector[index] ?? 0) * ((descriptionVector[index] ?? 0) / length);
    return total;
  };
  return { relevant: relevant.map(score), notRelevant: notRelevant.map(score) };
}
