import {
  LongContextReorder,
  MaximalMarginalRelevance,
  type Passage,
  PostprocessingRetriever,
  type QueryType,
  type RankedPassage,
  type Retriever,
} from '../index.ts';
import { embeddingModel } from './embedding-model.ts';

/** A composite as a test row gives it: alone, or under a wrapper. */
type Around<I extends RankedPassage> = (
  retriever: Retriever<QueryType, Passage, I>,
) => Retriever<QueryType, Passage, I>;

/**
 * The rows of a `test.each` that runs a claim about the items of a composite
 * on the composite alone, and under a `PostprocessingRetriever` whose
 * postprocessor reorders the list, since a postprocessor keeps the items it
 * gets (ADR 0024). With `queryVectors`, the vector of each query the claim
 * calls with, a third row runs it under `MaximalMarginalRelevance`, which
 * needs the vector of every item, so the claim's calls ask for vectors. A
 * claim over these rows reads the items by id, not by place.
 */
export const aloneAndPostprocessed = <I extends RankedPassage>(
  options: {
    readonly queryVectors?: Readonly<Record<string, readonly number[]>>;
  } = {},
): readonly (readonly [name: string, around: Around<I>])[] => {
  const rows: (readonly [name: string, around: Around<I>])[] = [
    ['alone', (retriever) => retriever],
    [
      'under a PostprocessingRetriever',
      (retriever) =>
        new PostprocessingRetriever({
          retriever,
          postprocessors: [new LongContextReorder()],
        }),
    ],
  ];
  const { queryVectors } = options;
  if (queryVectors !== undefined) {
    rows.push([
      'under MaximalMarginalRelevance',
      (retriever) =>
        new PostprocessingRetriever({
          retriever,
          postprocessors: [
            new MaximalMarginalRelevance({
              model: embeddingModel(queryVectors),
              topK: 10,
            }),
          ],
        }),
    ]);
  }
  return rows;
};
