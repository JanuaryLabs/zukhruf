import { type Collection, UnknownDocumentError } from '@zukhruf/embeddings';

import {
  type Article,
  type Keyword,
  Profile,
  type RelevanceFilter,
  type Vectors,
} from '../src/index.ts';
import type { Answers } from './teaching.ts';

// The frozen design (freeze/plan.json, desc|binormal+kw) through the API of
// the package: a profile with the reader's keyword learns from the answers
// and decides on the stream.
export function runDesign(options: {
  readonly profile: { readonly id: string; readonly description: string };
  readonly keyword: Keyword;
  readonly answers: Answers;
  readonly vectors: Vectors;
  readonly descriptionVector: readonly number[];
  readonly stream: readonly [Article, ...Article[]];
  readonly textOf: (id: string) => string;
}): RelevanceFilter {
  return new Profile({
    name: options.profile.id,
    description: options.profile.description,
    keywords: [options.keyword],
    relevant: options.answers.relevant,
    notRelevant: options.answers.notRelevant,
  }).train({
    vectors: options.vectors,
    descriptionVector: options.descriptionVector,
    stream: options.stream,
    taughtText: options.textOf,
  });
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
