// mteb/models/hybrid_wrappers.py: HybridSearch and its three fusions.
import type { MTEBModels } from '../abstasks/abstask.ts';
import { mean, std } from '../dependencies/numpy.ts';
import {
  type ScoredId,
  compareScoredIds,
  zipStrictMismatch,
} from '../dependencies/python.ts';
import type {
  CorpusDatasetType,
  QueryDatasetType,
  RetrievalOutputType,
} from '../types/encoder-io.ts';
import { ModelMeta } from './model-meta.ts';
import {
  type IndexOptions,
  type SearchOptions,
  type SearchProtocol,
  isCrossEncoder,
  isEncoder,
  isSearch,
} from './models-protocols.ts';
import {
  SearchCrossEncoderWrapper,
  SearchEncoderWrapper,
} from './search-wrappers.ts';

// The score of each document of one query, for each sub-model, in the order
// of the sub-model's results.
export type FusionFunction = (
  queryScoresList: readonly ReadonlyMap<string, number>[],
  weights: readonly number[],
) => ReadonlyMap<string, number>;

export type FusionStrategy = 'rrf' | 'dbsf' | 'rsf' | FusionFunction;

export type HybridSearchOptions = {
  readonly models: readonly MTEBModels[];
  // One weight for each model. The default gives each model 1 / the number
  // of models.
  readonly weights?: readonly number[];
  // The number of documents that each sub-model finds for a query. The
  // default is 100; a greater topK of the search wins.
  readonly subModelTopK?: number;
  readonly fusionStrategy?: FusionStrategy;
  // The rank constant of Reciprocal Rank Fusion.
  readonly rrfK?: number;
};

// Searches with each sub-model, fuses the scores of each query, and keeps
// the topK documents with the greatest fused scores.
export class HybridSearch implements SearchProtocol {
  readonly weights: readonly number[];
  readonly subModelTopK: number | null;
  readonly rrfK: number;
  readonly wrappedModels: readonly SearchProtocol[];
  readonly fusionName: string;
  readonly mtebModelMeta: ModelMeta;
  readonly #fuseFn: FusionFunction;

  constructor(options: HybridSearchOptions) {
    const { models } = options;
    if (models.length < 2)
      throw new RangeError(
        'At least two models must be provided for hybrid search.',
      );
    this.weights = options.weights ?? models.map(() => 1.0 / models.length);
    if (this.weights.length !== models.length)
      throw new RangeError(
        'Length of weights must match the number of models.',
      );
    const subModelTopK = options.subModelTopK ?? null;
    if (subModelTopK !== null && subModelTopK <= 0)
      throw new RangeError('sub_model_top_k must be greater than 0');
    this.subModelTopK = subModelTopK;
    const rrfK = options.rrfK ?? 60;
    if (!Number.isInteger(rrfK))
      throw new TypeError('rrf_k must be an integer');
    if (rrfK < 0)
      throw new RangeError('rrf_k must be greater than or equal to 0');
    this.rrfK = rrfK;

    this.wrappedModels = models.map((model) => {
      if (isEncoder(model) && !isSearch(model))
        return new SearchEncoderWrapper(model);
      if (isCrossEncoder(model)) return new SearchCrossEncoderWrapper(model);
      if (isSearch(model)) return model;
      throw new TypeError(
        'Expected a SearchProtocol, EncoderProtocol, or CrossEncoderProtocol',
      );
    });
    const names = this.wrappedModels.map(({ mtebModelMeta: { name } }) =>
      name ? (name.split('/').at(-1) ?? name) : 'unknown',
    );

    const strategy = options.fusionStrategy ?? 'rrf';
    if (typeof strategy === 'string') {
      this.fusionName = strategy;
      this.#fuseFn =
        strategy === 'rrf'
          ? (queryScoresList, weights) =>
              fuseRrf(queryScoresList, weights, this.rrfK)
          : strategy === 'dbsf'
            ? fuseDbsf
            : fuseRelativeScoreFusion;
    } else {
      // Python's __name__: an anonymous function is "custom".
      this.fusionName = strategy.name || 'custom';
      this.#fuseFn = strategy;
    }

    // MTEB gives a hybrid no experiment arguments, so two hybrids of the
    // same models with other settings share one name and one cached result.
    // Here the settings that are not the defaults are its experiment
    // arguments: the hybrid with all defaults keeps the identity of MTEB.
    const subModels = this.wrappedModels.map(
      ({ mtebModelMeta }) => mtebModelMeta.experimentName,
    );
    const experimentKwargs = {
      ...(subModels.some((name) => name !== null) && {
        sub_models: subModels,
      }),
      ...(options.weights !== undefined && { weights: this.weights }),
      ...(strategy === 'rrf' && this.rrfK !== 60 && { rrf_k: this.rrfK }),
      ...(this.subModelTopK !== null && {
        sub_model_top_k: this.subModelTopK,
      }),
    };
    this.mtebModelMeta = ModelMeta.createEmpty({
      name: `mteb/baseline-hybrid-${this.fusionName}-${names.join('-')}`,
      modelType: ['hybrid'],
      experimentKwargs:
        Object.keys(experimentKwargs).length > 0 ? experimentKwargs : null,
    });
  }

  async index(corpus: CorpusDatasetType, options: IndexOptions): Promise<void> {
    for (const model of this.wrappedModels)
      await model.index(corpus, {
        taskMetadata: options.taskMetadata,
        hfSplit: options.hfSplit,
        hfSubset: options.hfSubset,
        encodeKwargs: options.encodeKwargs,
      });
  }

  // Equal fused scores are ordered by descending document id before the
  // topK cut.
  async search(
    queries: QueryDatasetType,
    options: SearchOptions,
  ): Promise<RetrievalOutputType> {
    const subTopK = Math.max(options.topK, this.subModelTopK ?? 100);
    const allResults: RetrievalOutputType[] = [];
    for (const model of this.wrappedModels)
      allResults.push(
        await model.search(queries, {
          topK: subTopK,
          taskMetadata: options.taskMetadata,
          hfSplit: options.hfSplit,
          hfSubset: options.hfSubset,
          encodeKwargs: options.encodeKwargs,
          topRanked: options.topRanked ?? null,
        }),
      );

    const fusedResults: RetrievalOutputType = new Map();
    for (const { id } of queries) {
      const fused = this.fuse(
        allResults.map((results) => results.get(id) ?? new Map()),
      );
      const sorted = [...fused]
        .map(([docId, score]): ScoredId => [score, docId])
        .sort((left, right) => compareScoredIds(right, left));
      fusedResults.set(
        id,
        new Map(
          sorted.slice(0, options.topK).map(([score, docId]) => [docId, score]),
        ),
      );
    }
    return fusedResults;
  }

  fuse(
    queryScoresList: readonly ReadonlyMap<string, number>[],
  ): ReadonlyMap<string, number> {
    return this.#fuseFn(queryScoresList, this.weights);
  }
}

// Python's zip(scores, weights, strict=True).
function zipStrict(
  queryScoresList: readonly ReadonlyMap<string, number>[],
  weights: readonly number[],
): [ReadonlyMap<string, number>, number][] {
  const mismatch = zipStrictMismatch([queryScoresList.length, weights.length]);
  if (mismatch !== null) throw new RangeError(mismatch);
  return queryScoresList.map((scores, index) => [scores, weights[index] ?? 0]);
}

// Adds the weighted normalized score of each document to its fused score.
function addWeighted(
  fused: Map<string, number>,
  docIds: readonly string[],
  normalized: readonly number[],
  weight: number,
): void {
  for (const [index, docId] of docIds.entries())
    fused.set(
      docId,
      (fused.get(docId) ?? 0.0) + weight * (normalized[index] ?? 0),
    );
}

// Distribution-Based Score Fusion (https://arxiv.org/html/2410.20878v1):
// each score is placed between mean - 3 std and mean + 3 std, and clipped to
// [0, 1]. Scores with a std below 1e-9 all become 0.5.
export function fuseDbsf(
  queryScoresList: readonly ReadonlyMap<string, number>[],
  weights: readonly number[],
): Map<string, number> {
  const fused = new Map<string, number>();
  for (const [scores, weight] of zipStrict(queryScoresList, weights)) {
    if (scores.size === 0) continue;
    const docIds = [...scores.keys()];
    const rawScores = [...scores.values()];
    const mu = mean(rawScores);
    const sigma = std(rawScores);
    let normalized: number[];
    if (sigma < 1e-9) normalized = rawScores.map(() => 0.5);
    else {
      const lowerLimit = mu - 3 * sigma;
      const upperLimit = mu + 3 * sigma;
      const denom = upperLimit - lowerLimit;
      normalized = rawScores.map((score) =>
        Math.min(Math.max((score - lowerLimit) / denom, 0.0), 1.0),
      );
    }
    addWeighted(fused, docIds, normalized, weight);
  }
  return fused;
}

// Reciprocal Rank Fusion: each document adds weight / (rrfK + rank). Equal
// scores rank by descending document id, as the retrieval evaluation does.
export function fuseRrf(
  queryScoresList: readonly ReadonlyMap<string, number>[],
  weights: readonly number[],
  rrfK = 60,
): Map<string, number> {
  const fused = new Map<string, number>();
  for (const [scores, weight] of zipStrict(queryScoresList, weights)) {
    const sortedDocs = [...scores]
      .map(([docId, score]): ScoredId => [score, docId])
      .sort((left, right) => compareScoredIds(right, left));
    for (const [rankIdx, [, docId]] of sortedDocs.entries()) {
      const rank = rankIdx + 1;
      fused.set(
        docId,
        (fused.get(docId) ?? 0.0) + weight * (1.0 / (rrfK + rank)),
      );
    }
  }
  return fused;
}

// Relative Score Fusion: min-max normalization. Scores that are all equal
// become 0.5.
export function fuseRelativeScoreFusion(
  queryScoresList: readonly ReadonlyMap<string, number>[],
  weights: readonly number[],
): Map<string, number> {
  const fused = new Map<string, number>();
  for (const [scores, weight] of zipStrict(queryScoresList, weights)) {
    if (scores.size === 0) continue;
    const docIds = [...scores.keys()];
    const rawScores = [...scores.values()];
    const minS = rawScores.reduce((left, right) => Math.min(left, right));
    const maxS = rawScores.reduce((left, right) => Math.max(left, right));
    const normalized =
      maxS === minS
        ? rawScores.map(() => 0.5)
        : rawScores.map((score) => (score - minS) / (maxS - minS));
    addWeighted(fused, docIds, normalized, weight);
  }
  return fused;
}
