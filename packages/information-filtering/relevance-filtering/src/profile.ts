import { binormal } from './binormal.ts';
import {
  ConflictingAnswerError,
  MissingVectorError,
  NoEvidenceError,
} from './errors.ts';
import { withKeywordEvidence } from './evidence.ts';
import { expectedF05Threshold } from './expected-f.ts';
import { type Keyword, matchesAny } from './keyword.ts';
import { platt, plattProbability } from './platt.ts';
import {
  CalibratedFilter,
  type Calibration,
  KeywordFilter,
  type RankedArticle,
  type RelevanceFilter,
} from './relevance-filter.ts';
import type { Vectors } from './vectors.ts';

export type ProfileFields = {
  // The name that the reader gave the interest.
  readonly name: string;
  // One sentence that says what the reader wants to read. The caller embeds
  // it for train.
  readonly description: string;
  readonly keywords?: readonly Keyword[];
  // The ids of the articles that the reader answered yes and no for.
  readonly relevant: readonly string[];
  readonly notRelevant: readonly string[];
};

// An article of the stream that the filter decides on.
export type Article = {
  readonly id: string;
  // The publish date that the vectors store for the article.
  readonly publishedAt: Date;
  // The text that the keywords are matched in, for example the title and
  // the lead.
  readonly text: string;
};

export type TrainOptions = {
  // The vectors of the stream and of the taught articles.
  readonly vectors: Vectors;
  // The vector of the description, from the model of the stored vectors,
  // with the prompt that the model uses for a query (docs/adr/0002).
  readonly descriptionVector: readonly number[];
  // The articles to decide on. The binormal model is fitted on their
  // scores, so the filter decides on exactly these articles.
  readonly stream: readonly [Article, ...Article[]];
  // The text of a taught relevant article, which the keywords are matched
  // in. It is asked only when the profile has keywords.
  readonly taughtText: (id: string) => string;
};

// A reader's interest: a name, a description, optional keywords and the
// answers that taught it. It is a value: it does no I/O, and a correction
// gives a new profile (docs/adr/0001).
export class Profile {
  readonly name: string;
  readonly description: string;
  readonly keywords: readonly Keyword[];
  readonly relevant: readonly string[];
  readonly notRelevant: readonly string[];

  constructor(fields: ProfileFields) {
    const relevant = new Set(fields.relevant);
    const conflict = fields.notRelevant.find((id) => relevant.has(id));
    if (conflict !== undefined) throw new ConflictingAnswerError(conflict);
    this.name = fields.name;
    this.description = fields.description;
    this.keywords = Object.freeze([...(fields.keywords ?? [])]);
    this.relevant = Object.freeze([...fields.relevant]);
    this.notRelevant = Object.freeze([...fields.notRelevant]);
  }

  // A copy of the profile with the given fields changed.
  with(changes: Partial<ProfileFields>): Profile {
    return new Profile({
      name: this.name,
      description: this.description,
      keywords: this.keywords,
      relevant: this.relevant,
      notRelevant: this.notRelevant,
      ...changes,
    });
  }

  // Learns from the answers and ranks and decides on the stream
  // (docs/adr/0002, docs/adr/0004).
  train(options: TrainOptions): RelevanceFilter {
    const { stream } = options;
    if (new Set(stream.map(({ id }) => id)).size !== stream.length)
      throw new RangeError('Each article of the stream must have its own id.');
    const scores = streamScores(options);
    const ranked = stream.map(({ id, publishedAt }, index) => ({
      id,
      publishedAt,
      similarity: scores[index] ?? 0,
    }));
    const matches = () =>
      stream.map(({ text }) => matchesAny(this.keywords, text));
    if (this.relevant.length === 0) return this.#keywordFilter(ranked, matches);
    const taught = taughtScores(options, this.relevant, this.notRelevant);
    const fitted = binormal(scores, taught.relevant, taught.notRelevant);
    let probabilities: number[];
    let calibration: Calibration;
    if (fitted !== undefined) {
      probabilities = fitted.probabilities;
      calibration = { method: 'binormal', ...fitted.fit };
    } else if (this.notRelevant.length > 0) {
      const fit = platt(taught.relevant, taught.notRelevant);
      probabilities = scores.map((score) => plattProbability(fit, score));
      calibration = fit;
    } else return this.#keywordFilter(ranked, matches);
    if (this.keywords.length > 0)
      probabilities = withKeywordEvidence(
        probabilities,
        matches(),
        this.relevant.map((id) =>
          matchesAny(this.keywords, options.taughtText(id)),
        ),
      );
    return new CalibratedFilter({
      stream: ranked,
      probabilities: new Map(
        stream.map(({ id }, index) => [id, probabilities[index] ?? 0]),
      ),
      calibration,
      threshold: expectedF05Threshold(probabilities),
    });
  }

  #keywordFilter(
    stream: readonly RankedArticle[],
    matches: () => boolean[],
  ): KeywordFilter {
    if (this.keywords.length === 0) throw new NoEvidenceError(this.name);
    const matched = matches();
    return new KeywordFilter({
      stream,
      matches: new Map(
        stream.map(({ id }, index) => [id, matched[index] ?? false]),
      ),
    });
  }
}

// The similarity of the description to each article of the stream, in the
// order of the stream, from one query over the publish dates of the stream.
function streamScores({ vectors, descriptionVector, stream }: TrainOptions) {
  const dates = stream.map(({ publishedAt }) => publishedAt.getTime());
  const similarities = new Map(
    vectors
      .query(descriptionVector, {
        from: new Date(dates.reduce((a, b) => Math.min(a, b))),
        to: new Date(dates.reduce((a, b) => Math.max(a, b))),
      })
      .map(({ id, similarity }) => [id, similarity]),
  );
  return stream.map(({ id }) => {
    const similarity = similarities.get(id);
    if (similarity === undefined) throw new MissingVectorError(id);
    return similarity;
  });
}

// The cosine of the description with each taught article: the dot product
// of the stored unit vector and the description made a unit vector.
function taughtScores(
  { vectors, descriptionVector }: TrainOptions,
  relevant: readonly string[],
  notRelevant: readonly string[],
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
