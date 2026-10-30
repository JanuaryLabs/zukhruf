import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { EmbeddingModelV4 } from '@ai-sdk/provider';

import { AbsTaskRetrieval } from '../abstasks/retrieval.ts';
import { TaskMetadata } from '../abstasks/task-metadata.ts';
import { evaluate } from '../evaluate.ts';
import { AiSdkEncoder } from './ai-sdk-encoder.ts';
import {
  type FusionFunction,
  HybridSearch,
  fuseDbsf,
  fuseRelativeScoreFusion,
  fuseRrf,
} from './hybrid-wrappers.ts';
import { bm25S } from './model-implementations/bm25.ts';
import { ModelMeta } from './model-meta.ts';

// fixtures/hybrid/expected.json holds what Python MTEB 2.26.28 gave for
// fuse_rrf, fuse_dbsf and fuse_relative_score_fusion on score maps, and for
// five HybridSearch models on the folder task of the BM25 fixture, and the
// experiment names that MTEB gives the experiment arguments of a hybrid.
// fixtures/hybrid/generate.py makes it.
type Pairs = [string, number][];

type Expected = {
  readonly one_hot_dim: number;
  readonly top_ranked: Readonly<Record<string, readonly string[]>>;
  readonly fusions: readonly {
    readonly case: string;
    readonly query_scores_list: Pairs[];
    readonly weights: number[];
    readonly rrf_60: Pairs;
    readonly rrf_0: Pairs;
    readonly dbsf: Pairs;
    readonly rsf: Pairs;
  }[];
  readonly searches: readonly {
    readonly model: ModelName;
    readonly top_k: number;
    readonly rerank: boolean;
    readonly results: [string, Pairs][];
  }[];
  readonly evaluations: readonly {
    readonly model: ModelName;
    readonly name: string;
    readonly main_score: number;
  }[];
  readonly experiment_names: readonly {
    readonly case: string;
    readonly experiment_name: string;
  }[];
};

type ModelName = 'rrf' | 'dbsf' | 'rsf' | 'custom' | 'encoder';

const expected: Expected = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/hybrid/expected.json'),
    'utf8',
  ),
);

const BM25_FOLDER = join(
  import.meta.dirname,
  'model-implementations/fixtures/bm25',
);

// The BM25 fixture without the instruction of its query q10: the dataloader
// of an encoder rejects a column that is missing in some rows.
class FolderTask extends AbsTaskRetrieval {
  constructor() {
    super({
      metadata: new TaskMetadata({
        name: 'HybridFixture',
        description: 'The hybrid search fixture of @zukhruf/mteb.',
        dataset: { path: BM25_FOLDER, revision: '1' },
        type: 'Retrieval',
        category: 't2t',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs: ['eng-Latn'],
        mainScore: 'ndcg_at_10',
      }),
    });
  }

  override datasetTransform(): void {
    const split = this.dataset?.get('default')?.get('test');
    assert.ok(split);
    split.queries = split.queries.map(({ id, text }) => ({ id, text }));
  }
}

// The one-hot embedding of generate.py: a 1 at (the sum of the code points
// of the text) % one_hot_dim.
function oneHotModel(): EmbeddingModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'one-hot',
    maxEmbeddingsPerCall: undefined,
    supportsParallelCalls: true,
    async doEmbed({ values }) {
      return {
        embeddings: values.map((value) => {
          let sum = 0;
          for (const character of value) sum += character.codePointAt(0) ?? 0;
          return Array.from({ length: expected.one_hot_dim }, (_, index) =>
            index === sum % expected.one_hot_dim ? 1 : 0,
          );
        }),
        usage: { tokens: values.length },
        warnings: [],
      };
    },
  };
}

// The custom fusion of generate.py: the greatest weighted score of each
// document.
const maximum: FusionFunction = (queryScoresList, weights) => {
  const fused = new Map<string, number>();
  for (const [index, scores] of queryScoresList.entries())
    for (const [doc, score] of scores)
      fused.set(
        doc,
        Math.max(fused.get(doc) ?? -Infinity, (weights[index] ?? 0) * score),
      );
  return fused;
};

function tuned() {
  return bm25S.loadModel({ k1: 1.2, b: 0.5 });
}

const MODELS: Record<ModelName, () => HybridSearch> = {
  rrf: () => new HybridSearch({ models: [bm25S.loadModel(), tuned()] }),
  dbsf: () =>
    new HybridSearch({
      models: [bm25S.loadModel(), tuned()],
      fusionStrategy: 'dbsf',
    }),
  rsf: () =>
    new HybridSearch({
      models: [bm25S.loadModel(), tuned()],
      fusionStrategy: 'rsf',
    }),
  custom: () =>
    new HybridSearch({
      models: [bm25S.loadModel(), tuned()],
      fusionStrategy: maximum,
    }),
  encoder: () =>
    new HybridSearch({
      models: [
        bm25S.loadModel(),
        new AiSdkEncoder({
          model: oneHotModel(),
          modelMeta: ModelMeta.createEmpty({
            name: 'test/one-hot',
            revision: '1',
          }),
        }),
      ],
      weights: [0.6, 0.4],
    }),
};

for (const fusion of expected.fusions)
  test(`the fusions of "${fusion.case}" give the scores of MTEB in the order of MTEB, to the last bit`, () => {
    const queryScoresList = fusion.query_scores_list.map(
      (pairs) => new Map(pairs),
    );

    const fused = {
      rrf_60: fuseRrf(queryScoresList, fusion.weights),
      rrf_0: fuseRrf(queryScoresList, fusion.weights, 0),
      dbsf: fuseDbsf(queryScoresList, fusion.weights),
      rsf: fuseRelativeScoreFusion(queryScoresList, fusion.weights),
    };

    assert.deepEqual(
      Object.fromEntries(
        Object.entries(fused).map(([name, scores]) => [name, [...scores]]),
      ),
      {
        rrf_60: fusion.rrf_60,
        rrf_0: fusion.rrf_0,
        dbsf: fusion.dbsf,
        rsf: fusion.rsf,
      },
    );
  });

for (const search of expected.searches)
  test(`the ${search.model} hybrid ${search.rerank ? 'reranks' : 'searches'} with topK ${search.top_k} and gives the results of MTEB, to the last bit`, async () => {
    const task = new FolderTask();
    await task.loadData();
    const split = task.dataset?.get('default')?.get('test');
    assert.ok(split);
    const location = {
      taskMetadata: task.metadata,
      hfSplit: 'test',
      hfSubset: 'default',
      encodeKwargs: {},
    };
    const model = MODELS[search.model]();
    await model.index(split.corpus, location);

    const results = await model.search(split.queries, {
      ...location,
      topK: search.top_k,
      topRanked: search.rerank
        ? new Map(Object.entries(expected.top_ranked))
        : null,
    });

    assert.deepEqual(
      [...results].map(([query, docs]) => [query, [...docs]]),
      search.results,
    );
  });

for (const evaluation of expected.evaluations)
  test(`evaluate gives the ${evaluation.model} hybrid the main score of MTEB`, async () => {
    const model = MODELS[evaluation.model]();

    const result = await evaluate(model, new FolderTask(), { cache: null });

    assert.deepEqual(
      [
        model.mtebModelMeta.name,
        result.taskResults[0]?.scores['test']?.[0]?.['main_score'],
      ],
      [evaluation.name, evaluation.main_score],
    );
  });

// The hybrid of each case of the experiment names of generate.py.
const EXPERIMENT_HYBRIDS: Record<string, () => HybridSearch> = {
  'a sub-model setting': () =>
    new HybridSearch({
      models: [bm25S.loadModel(), bm25S.loadModel({ k1: 1.2 })],
    }),
  weights: () =>
    new HybridSearch({
      models: [bm25S.loadModel(), bm25S.loadModel()],
      weights: [0.6, 0.4],
    }),
  rrf_k: () =>
    new HybridSearch({
      models: [bm25S.loadModel(), bm25S.loadModel()],
      rrfK: 10,
    }),
  sub_model_top_k: () =>
    new HybridSearch({
      models: [bm25S.loadModel(), bm25S.loadModel()],
      subModelTopK: 5,
    }),
  all: () =>
    new HybridSearch({
      models: [bm25S.loadModel({ k1: 1.2, b: 0.5 }), bm25S.loadModel()],
      weights: [0.7, 0.3],
      rrfK: 0,
      subModelTopK: 50,
    }),
};

test('a hybrid with settings that are not the defaults gets the experiment name that MTEB gives its experiment arguments', () => {
  const names = expected.experiment_names.map(({ case: name }) => {
    const make = EXPERIMENT_HYBRIDS[name];
    assert.ok(make, name);
    return { case: name, experiment_name: make().mtebModelMeta.experimentName };
  });

  assert.deepEqual(names, expected.experiment_names);
  assert.equal(names.length, Object.keys(EXPERIMENT_HYBRIDS).length);
});
