import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { EmbeddingModelV4 } from '@ai-sdk/provider';

import { AiSdkEncoder } from '../models/ai-sdk-encoder.ts';
import { ModelMeta } from '../models/model-meta.ts';
import type { CorpusRow, QueryRow } from '../types/encoder-io.ts';
import { AbsTaskRetrieval } from './retrieval.ts';
import { TaskMetadata } from './task-metadata.ts';

// A tiny retrieval task and the scores that MTEB 2.26.28 gave it, once as a
// full corpus search and once as a reranking of candidates. Each vector has
// the values 0, 0.5, -0.5 or 1, so its norm and each dot product are exact in
// float32, and the scores do not depend on the order of a BLAS sum.
type Fixture = {
  readonly corpus: readonly CorpusRow[];
  readonly queries: readonly QueryRow[];
  readonly qrels: [string, [string, number][]][];
  readonly top_ranked: [string, string[]][];
  readonly table: [string, number[]][];
  readonly k_values: readonly number[];
  readonly full: [string, number | string][];
  readonly rerank: [string, number | string][];
};

const fixture: Fixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/retrieval-task.json'),
    'utf8',
  ),
);

// A real embedding model cannot run in CI. This one implements the AI SDK
// interface and gives the vector of each text from the table of the fixture.
function tableModel(): EmbeddingModelV4 {
  const table = new Map(fixture.table);
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'table',
    maxEmbeddingsPerCall: undefined,
    supportsParallelCalls: true,
    async doEmbed({ values }) {
      return {
        embeddings: values.map((value) => {
          const vector = table.get(value);
          if (vector === undefined) throw new Error(`No vector for ${value}`);
          return vector;
        }),
        usage: { tokens: values.length },
        warnings: [],
      };
    },
  };
}

class TableTask extends AbsTaskRetrieval {
  override kValues = fixture.k_values;
  readonly #rerank: boolean;

  constructor(rerank: boolean) {
    super({
      metadata: new TaskMetadata({
        name: rerank ? 'Table-rerank' : 'Table-full',
        description: 'x',
        dataset: { path: 'local/x', revision: '1' },
        type: 'Retrieval',
        category: 't2t',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs: ['eng-Latn'],
        mainScore: 'ndcg_at_10',
      }),
    });
    this.#rerank = rerank;
  }

  override async loadData(): Promise<void> {
    this.dataset = new Map([
      [
        'default',
        new Map([
          [
            'test',
            {
              corpus: fixture.corpus,
              queries: fixture.queries,
              relevantDocs: new Map(
                fixture.qrels.map(([query, documents]) => [
                  query,
                  new Map(documents),
                ]),
              ),
              topRanked: this.#rerank ? new Map(fixture.top_ranked) : null,
            },
          ],
        ]),
      ],
    ]);
  }
}

function expected(pairs: [string, number | string][]): Record<string, number> {
  return Object.fromEntries(
    pairs.map(([key, value]) => [
      key,
      typeof value === 'string' ? Number(value) : value,
    ]),
  );
}

for (const [mode, rerank] of [
  ['a full corpus search', false],
  ['a reranking of candidates', true],
] as const)
  test(`the scores of ${mode} equal those of MTEB`, async () => {
    const encoder = new AiSdkEncoder({
      model: tableModel(),
      modelMeta: ModelMeta.createEmpty({ name: 'test/table', revision: '1' }),
    });
    const task = new TableTask(rerank);

    const scores = await task.evaluate(encoder, 'test', null, {
      encodeKwargs: { batchSize: 3 },
    });

    assert.deepEqual(
      scores.get('default'),
      expected(rerank ? fixture.rerank : fixture.full),
    );
  });

test('the encoder adds up the tokens that the model reports', async () => {
  const encoder = new AiSdkEncoder({ model: tableModel() });
  const task = new TableTask(true);

  await task.evaluate(encoder, 'test', null, {
    encodeKwargs: { batchSize: 3 },
  });

  // The model reports one token per text: 9 documents and the 5 queries
  // that have a relevant document.
  assert.equal(encoder.tokens, 14);
});
