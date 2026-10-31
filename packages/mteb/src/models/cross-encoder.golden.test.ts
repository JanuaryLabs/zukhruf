import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { RerankingModelV4 } from '@ai-sdk/provider';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { AbsTaskRetrieval } from '../abstasks/retrieval.ts';
import { TaskMetadata } from '../abstasks/task-metadata.ts';
import { evaluate } from '../evaluate.ts';
import { STSBenchmarkSTS } from '../tasks/sts/eng/sts-benchmark-sts.ts';
import { AiSdkReranker } from './ai-sdk-reranker.ts';
import { HybridSearch } from './hybrid-wrappers.ts';
import { noRerankingBaseline } from './model-implementations/random-baseline.ts';
import { SearchCrossEncoderWrapper } from './search-wrappers.ts';

// fixtures/cross-encoder/expected.json holds what Python MTEB 2.26.28 gave
// for NoRerankingBaseline, OpenAIAPIRerankWrapper over a fake reranking
// server and a HybridSearch of the two, on the reranking task in
// fixtures/cross-encoder/dataset. fixtures/cross-encoder/generate.py makes
// both.
type Pairs = [string, number][];

type Request = [query: string, documents: string[]];

type ModelName = 'baseline' | 'reranker' | 'hybrid';

type Expected = {
  readonly batch_size: number;
  readonly top_k: number;
  readonly searches: readonly {
    readonly model: 'baseline' | 'reranker';
    readonly requests: Request[];
    readonly results: [string, Pairs][];
  }[];
  readonly evaluations: readonly {
    readonly model: ModelName;
    readonly name: string;
    readonly main_score: number;
    readonly requests: Request[];
    readonly predictions: unknown;
    readonly phases: [name: string, split: string, subset: string][];
  }[];
};

const FIXTURE = join(import.meta.dirname, 'fixtures/cross-encoder');

const expected: Expected = JSON.parse(
  readFileSync(join(FIXTURE, 'expected.json'), 'utf8'),
);

class CrossEncoderFixture extends AbsTaskRetrieval {
  constructor() {
    super({
      metadata: new TaskMetadata({
        name: 'CrossEncoderFixture',
        description: 'The cross-encoder fixture of @zukhruf/mteb.',
        dataset: { path: join(FIXTURE, 'dataset'), revision: '1' },
        type: 'Reranking',
        category: 't2t',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs: ['eng-Latn'],
        mainScore: 'ndcg_at_10',
      }),
    });
  }
}

function codePoints(text: string): number {
  let sum = 0;
  for (const character of text) sum += character.codePointAt(0) ?? 0;
  return sum;
}

// The fake server of generate.py as an AI SDK reranking model: the same
// score for each pair, the ranking sorted by score as the server sorts it,
// and a log of the calls. It fails when a call starts before the last one
// ends.
function fakeReranker(): {
  readonly model: RerankingModelV4;
  readonly requests: Request[];
} {
  const requests: Request[] = [];
  let calls = 0;
  return {
    requests,
    model: {
      specificationVersion: 'v4',
      provider: 'test',
      modelId: 'fake/reranker',
      async doRerank({ documents, query }) {
        assert.equal(documents.type, 'text');
        assert.equal(calls, 0, 'two calls at the same time');
        calls += 1;
        try {
          await new Promise((resolve) => setImmediate(resolve));
          requests.push([query, documents.values]);
          const scores = documents.values.map(
            (document) =>
              ((codePoints(query) * 131 + codePoints(document) * 17) % 997) /
                997 +
              [...document].length / 3,
          );
          return {
            ranking: scores
              .map((relevanceScore, index) => ({ index, relevanceScore }))
              .sort(
                (left, right) => right.relevanceScore - left.relevanceScore,
              ),
          };
        } finally {
          calls -= 1;
        }
      },
    },
  };
}

function reranker(model: RerankingModelV4): AiSdkReranker {
  return new AiSdkReranker({ model });
}

function makeModel(name: ModelName, model: RerankingModelV4) {
  if (name === 'baseline') return noRerankingBaseline.loadModel();
  if (name === 'reranker') return reranker(model);
  return new HybridSearch({
    models: [noRerankingBaseline.loadModel(), reranker(model)],
  });
}

// A JSON value with each object as its entries, so that a comparison sees
// the order of the keys.
function nested(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(nested);
  if (typeof value === 'object' && value !== null)
    return Object.entries(value).map(([key, item]) => [key, nested(item)]);
  return value;
}

for (const search of expected.searches)
  test(`SearchCrossEncoderWrapper over the ${search.model} scores each candidate in the order of MTEB, sends the requests of MTEB and gives its scores, to the last bit`, async () => {
    const task = new CrossEncoderFixture();
    await task.loadData();
    const split = task.dataset?.get('default')?.get('test');
    assert.ok(split);
    const location = {
      taskMetadata: task.metadata,
      hfSplit: 'test',
      hfSubset: 'default',
      encodeKwargs: { batchSize: expected.batch_size },
    };
    const { model, requests } = fakeReranker();
    const wrapper = new SearchCrossEncoderWrapper(
      search.model === 'baseline'
        ? noRerankingBaseline.loadModel()
        : reranker(model),
    );
    await wrapper.index(split.corpus, location);

    const results = await wrapper.search(split.queries, {
      ...location,
      topK: expected.top_k,
      topRanked: split.topRanked,
    });

    assert.deepEqual(
      {
        requests,
        results: [...results].map(([query, docs]) => [query, [...docs]]),
      },
      { requests: search.requests, results: search.results },
    );
  });

for (const evaluation of expected.evaluations)
  test(`evaluate gives the ${evaluation.model} the predictions, main score and phases of MTEB`, async () => {
    await using folder = await new TemporaryFiles().directory(
      'mteb-cross-encoder-',
    );
    const { model, requests } = fakeReranker();
    const task = new CrossEncoderFixture();
    const subject = makeModel(evaluation.model, model);

    const result = await evaluate(subject, task, {
      cache: null,
      encodeKwargs: { batchSize: expected.batch_size },
      predictionFolder: folder.path,
    });

    const taskResult = result.taskResults[0];
    assert.ok(taskResult);
    assert.deepEqual(
      {
        name: subject.mtebModelMeta.name,
        mainScore: taskResult.scores['test']?.[0]?.['main_score'],
        requests,
        predictions: nested(
          JSON.parse(
            readFileSync(
              join(folder.path, `${task.metadata.name}_predictions.json`),
              'utf8',
            ),
          ),
        ),
        phases: taskResult.evaluationPhases?.map(({ name, split, subset }) => [
          name,
          split,
          subset,
        ]),
      },
      {
        name: evaluation.name,
        mainScore: evaluation.main_score,
        requests: evaluation.requests,
        predictions: evaluation.predictions,
        phases: evaluation.phases,
      },
    );
  });

test('a model without a score for its document throws, where MTEB scores the pair 0', async () => {
  const model: RerankingModelV4 = {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'test/empty',
    async doRerank() {
      return { ranking: [] };
    },
  };

  await assert.rejects(
    evaluate(new AiSdkReranker({ model }), new CrossEncoderFixture(), {
      cache: null,
    }),
    new Error('Incomplete ranking from server: expected 1 score, got 0.'),
  );
});

test('a cross-encoder throws on a task without candidates, as MTEB raises', async () => {
  const { model } = fakeReranker();
  const wrapper = new SearchCrossEncoderWrapper(reranker(model));
  const task = new CrossEncoderFixture();
  await task.loadData();
  const split = task.dataset?.get('default')?.get('test');
  assert.ok(split);
  const location = {
    taskMetadata: task.metadata,
    hfSplit: 'test',
    hfSubset: 'default',
    encodeKwargs: {},
  };
  await wrapper.index(split.corpus, location);

  await assert.rejects(
    wrapper.search(split.queries, { ...location, topK: 10, topRanked: null }),
    new Error(
      'CrossEncoder search requires top_ranked documents for reranking.',
    ),
  );
});

// AbsTask.evaluate checks the model before it loads the data, so the task
// reaches no network.
test('a cross-encoder on a task that is not a retrieval task throws the TypeError of MTEB', async () => {
  await assert.rejects(
    new STSBenchmarkSTS().evaluate(
      noRerankingBaseline.loadModel(),
      'test',
      null,
      {
        encodeKwargs: {},
      },
    ),
    new TypeError(
      'Model mteb/baseline-no-reranking is a CrossEncoder, but this task STSBenchmark does not support CrossEncoders. Please use a Encoder model instead.',
    ),
  );
});
