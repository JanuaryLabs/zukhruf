import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { RerankingModelV4 } from '@ai-sdk/provider';
import { z } from 'zod';

import { AbsTaskRetrieval } from '../../abstasks/retrieval.ts';
import { TaskMetadata } from '../../abstasks/task-metadata.ts';
import { zipStrictMismatch } from '../../dependencies/python.ts';
import { evaluate } from '../../evaluate.ts';
import { AiSdkReranker } from '../ai-sdk-reranker.ts';
import type { CrossEncoderKwargs, ModelMeta } from '../model-meta.ts';
import {
  qwen3Reranker0B6,
  qwen3Reranker4B,
  qwen3Reranker8B,
} from './qwen3-reranker.ts';
import { noRerankingBaseline } from './random-baseline.ts';
import {
  bgeRerankerV2M3,
  jinaRerankerMultilingual,
  msMarcoMinilmL2V2,
  msMarcoMinilmL4V2,
  msMarcoMinilmL6V2,
  msMarcoMinilmL12V2,
  msMarcoTinybertL2V2,
} from './rerankers-custom.ts';

// fixtures/rerankers/expected.json holds what Python MTEB 2.26.28 gave for
// the metadata of each cross-encoder, the texts that the model of each
// loader scores on the cross-encoder fixture task, the errors of
// zip(strict=True), the pairs or the error of Qwen3RerankerWrapper.predict
// with batch_size 2, and the error of each wrapper for 2 queries and 1
// document. fixtures/rerankers/generate.py makes it.
const expected = z
  .object({
    batch_size: z.number(),
    metas: z.array(z.record(z.string(), z.unknown())),
    texts: z.record(
      z.enum([
        'BGEReranker',
        'JinaReranker',
        'CrossEncoderWrapper',
        'Qwen3RerankerWrapper',
      ]),
      z.array(z.array(z.string())),
    ),
    zip_errors: z.array(z.tuple([z.array(z.number()), z.string().nullable()])),
    qwen3_batches: z.array(
      z.tuple([
        z.tuple([z.number(), z.number()]),
        z.union([
          z.object({ pairs: z.number() }),
          z.object({ error: z.string() }),
        ]),
      ]),
    ),
    length_errors: z.object({
      BGEReranker: z.string(),
      JinaReranker: z.string(),
      CrossEncoderWrapper: z.string(),
      OpenAIAPIRerankWrapper: z.string(),
    }),
  })
  .parse(
    JSON.parse(
      readFileSync(
        join(import.meta.dirname, 'fixtures/rerankers/expected.json'),
        'utf8',
      ),
    ),
  );

type LoaderName = keyof typeof expected.texts;

const DATASET = join(import.meta.dirname, '../fixtures/cross-encoder/dataset');

class CrossEncoderFixture extends AbsTaskRetrieval {
  constructor() {
    super({
      metadata: new TaskMetadata({
        name: 'CrossEncoderFixture',
        description: 'The cross-encoder fixture of @zukhruf/mteb.',
        dataset: { path: DATASET, revision: '1' },
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

// A served model cannot run in CI. This one implements the AI SDK interface,
// records the query and the documents of each call, and scores 0.
function recordingModel(): {
  readonly model: RerankingModelV4;
  readonly pairs: string[][];
} {
  const pairs: string[][] = [];
  return {
    pairs,
    model: {
      specificationVersion: 'v4',
      provider: 'test',
      modelId: 'recorder',
      async doRerank({ documents, query }) {
        assert.equal(documents.type, 'text');
        pairs.push([query, ...documents.values]);
        return {
          ranking: documents.values.map((_, index) => ({
            index,
            relevanceScore: 0,
          })),
        };
      },
    },
  };
}

test('the metadata of each cross-encoder is the metadata of MTEB, field for field and in its order', () => {
  const metas: readonly { toDict(): Record<string, unknown> }[] = [
    noRerankingBaseline,
    bgeRerankerV2M3,
    jinaRerankerMultilingual,
    msMarcoTinybertL2V2,
    msMarcoMinilmL2V2,
    msMarcoMinilmL4V2,
    msMarcoMinilmL6V2,
    msMarcoMinilmL12V2,
    qwen3Reranker0B6,
    qwen3Reranker4B,
    qwen3Reranker8B,
  ];

  const dicts = metas.map((meta) => {
    const dict = meta.toDict();
    const datasets = dict['training_datasets'];
    // The fixture sorts the training datasets, a Python set, and writes a
    // non-finite number as its name.
    return Object.entries({
      ...dict,
      training_datasets: Array.isArray(datasets)
        ? datasets.map(String).sort()
        : datasets,
    }).map(([key, value]) => [
      key,
      typeof value === 'number' && !Number.isFinite(value)
        ? String(value)
        : value,
    ]);
  });

  assert.deepEqual(
    dicts,
    expected.metas.map((meta) => Object.entries(meta)),
  );
});

const LOADERS: readonly [LoaderName, ModelMeta<CrossEncoderKwargs>][] = [
  ['BGEReranker', bgeRerankerV2M3],
  ['JinaReranker', jinaRerankerMultilingual],
  ['CrossEncoderWrapper', msMarcoMinilmL6V2],
  ['Qwen3RerankerWrapper', qwen3Reranker0B6],
];

for (const [name, meta] of LOADERS)
  test(`the ${name} loader sends each pair as the query and the document that the model of MTEB scores`, async () => {
    const { model, pairs } = recordingModel();
    // Qwen3 also gives its model the instruction, which a reranking server
    // takes from its own template.
    const want = expected.texts[name].map((texts) => texts.slice(-2));

    await evaluate(meta.loadModel({ model }), new CrossEncoderFixture(), {
      cache: null,
      encodeKwargs: { batchSize: expected.batch_size },
    });

    assert.deepEqual(pairs, want);
  });

test('zipStrictMismatch gives the error of zip(strict=True) of CPython', () => {
  const errors = expected.zip_errors.map(([lengths]) => [
    lengths,
    zipStrictMismatch(lengths),
  ]);

  assert.deepEqual(errors, expected.zip_errors);
});

for (const [[queries, passages], outcome] of expected.qwen3_batches)
  test(`Qwen3-Reranker with ${queries} queries and ${passages} documents in batches of 2 ${'error' in outcome ? 'throws' : 'scores'} as MTEB does`, async () => {
    const { model, pairs } = recordingModel();
    const reranker = qwen3Reranker0B6.loadModel({ model });
    const task = new CrossEncoderFixture();
    const texts = (prefix: string, count: number) => [
      {
        text: Array.from({ length: count }, (_, index) => `${prefix}${index}`),
      },
    ];

    const scored = reranker.predict(texts('q', queries), texts('d', passages), {
      taskMetadata: task.metadata,
      hfSplit: 'test',
      hfSubset: 'default',
      batchSize: 2,
    });

    if ('error' in outcome)
      await assert.rejects(scored, new Error(outcome.error));
    else {
      await scored;
      assert.equal(pairs.length, outcome.pairs);
    }
  });

test('each cross-encoder throws the error of its MTEB wrapper for 2 queries and 1 document', async () => {
  const { model } = recordingModel();
  const task = new CrossEncoderFixture();
  const options = {
    taskMetadata: task.metadata,
    hfSplit: 'test',
    hfSubset: 'default',
  };
  const queries = [{ text: ['q0 i', 'q1 i'], query: ['q0', 'q1'] }];
  const documents = [{ text: ['d0'] }];
  const wrappers = {
    BGEReranker: bgeRerankerV2M3.loadModel({ model }),
    JinaReranker: jinaRerankerMultilingual.loadModel({ model }),
    CrossEncoderWrapper: msMarcoMinilmL6V2.loadModel({ model }),
    OpenAIAPIRerankWrapper: new AiSdkReranker({ model }),
  };

  const errors = Object.fromEntries(
    await Promise.all(
      Object.entries(wrappers).map(async ([name, wrapper]) => [
        name,
        await wrapper.predict(queries, documents, options).then(
          () => 'no error',
          (error: unknown) =>
            error instanceof Error ? error.message : String(error),
        ),
      ]),
    ),
  );

  assert.deepEqual(errors, expected.length_errors);
});
