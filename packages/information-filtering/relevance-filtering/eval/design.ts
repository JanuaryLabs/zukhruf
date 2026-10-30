import { type Collection, UnknownDocumentError } from '@zukhruf/embeddings';

import {
  type Article,
  type Keyword,
  KeywordScorer,
  type Scores,
  SimilarityScorer,
  TaughtAnswers,
  type Vectors,
} from '../src/index.ts';
import type { Answers } from './teaching.ts';

// The frozen design (freeze/plan.json, desc|binormal+kw) through the API of
// the package: the similarity scorer learns from the reader's answers and
// keyword, and a profile with no yes answer starts with the keyword scorer.
// The stream and the answers keep their order, which the binormal fit's sums
// follow to the last bit.
export function runDesign(options: {
  readonly keyword: Keyword;
  readonly answers: Answers;
  readonly vectors: Vectors;
  readonly descriptionVector: readonly number[];
  readonly stream: readonly (Article & { readonly id: string })[];
  readonly textOf: (id: string) => string;
}): Promise<Scores> {
  const { vectors, descriptionVector, textOf } = options;
  const answer = (relevant: boolean) => (id: string) =>
    [id, { relevant, text: textOf(id) }] as const;
  const taught = TaughtAnswers.parse(
    new Map([
      ...options.answers.relevant.map(answer(true)),
      ...options.answers.notRelevant.map(answer(false)),
    ]),
  );
  const scorer =
    taught === undefined
      ? new KeywordScorer({
          vectors,
          descriptionVector,
          keywords: [options.keyword],
        })
      : new SimilarityScorer({
          vectors,
          descriptionVector,
          answers: taught,
          keywords: [options.keyword],
        });
  return scorer.score(
    new Map(
      options.stream.map(({ id, publishedAt, text }) => [
        id,
        { publishedAt, text },
      ]),
    ),
  );
}

// The vectors of several collections as one port: a query reads the
// collection of the stream, and a fetch finds each id in the first
// collection that stores it. The exam teaches from the pool collections and
// decides on the exam collection.
export function joined(
  stream: Collection,
  pool: readonly Collection[],
): Vectors {
  return {
    query: (vector, range) => stream.query(vector, range),
    fetch: (ids) =>
      new Map(ids.map((id) => [id, fetchOne([stream, ...pool], id)])),
  };
}

function fetchOne(collections: readonly Collection[], id: string) {
  const [first, ...rest] = collections;
  if (first === undefined) throw new UnknownDocumentError(id);
  try {
    return first.fetch([id]).get(id) ?? [];
  } catch (error) {
    if (!(error instanceof UnknownDocumentError)) throw error;
    return fetchOne(rest, id);
  }
}
