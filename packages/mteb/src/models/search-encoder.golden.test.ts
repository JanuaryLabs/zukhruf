import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { EmbeddingModelV4 } from '@ai-sdk/provider';

import { TaskMetadata } from '../abstasks/task-metadata.ts';
import { AiSdkEncoder } from './ai-sdk-encoder.ts';
import { ModelMeta } from './model-meta.ts';
import { SearchEncoderWrapper } from './search-wrappers.ts';

// fixtures/search-encoder/expected.json holds a corpus, its queries, and the
// results that SearchEncoderWrapper of Python MTEB 2.26.28 gave when it
// searched the corpus in chunks with a top_k smaller than the corpus.
// fixtures/search-encoder/generate.py makes it.
type Row = { readonly id: string; readonly text: string };

type Expected = {
  readonly corpus_chunk_size: number;
  readonly corpus: readonly Row[];
  readonly queries: readonly Row[];
  readonly searches: readonly {
    readonly top_k: number;
    readonly results: [string, [string, number][]][];
  }[];
};

const expected: Expected = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/search-encoder/expected.json'),
    'utf8',
  ),
);

// The model of generate.py: the text "3 5" is the vector [3, 5].
function coordinatesModel(): EmbeddingModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'coordinates',
    maxEmbeddingsPerCall: undefined,
    supportsParallelCalls: true,
    async doEmbed({ values }) {
      return {
        embeddings: values.map((value) => value.split(' ').map(Number)),
        usage: { tokens: values.length },
        warnings: [],
      };
    },
  };
}

for (const search of expected.searches)
  test(`SearchEncoderWrapper searches ${expected.corpus.length} documents in chunks of ${expected.corpus_chunk_size} with topK ${search.top_k} and gives the documents of MTEB in the order of MTEB`, async () => {
    const location = {
      taskMetadata: new TaskMetadata({
        name: 'SearchEncoderFixture',
        description: 'The search encoder fixture of @zukhruf/mteb.',
        dataset: { path: 'none', revision: '1' },
        type: 'Retrieval',
        category: 't2t',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs: ['eng-Latn'],
        mainScore: 'ndcg_at_10',
      }),
      hfSplit: 'test',
      hfSubset: 'default',
      encodeKwargs: {},
    };
    const model = new SearchEncoderWrapper(
      new AiSdkEncoder({
        model: coordinatesModel(),
        modelMeta: ModelMeta.createEmpty({
          name: 'test/coordinates',
          revision: '1',
          similarityFnName: 'dot',
        }),
      }),
      { corpusChunkSize: expected.corpus_chunk_size },
    );
    await model.index(expected.corpus, location);

    const results = await model.search(expected.queries, {
      ...location,
      topK: search.top_k,
      topRanked: null,
    });

    assert.deepEqual(
      [...results].map(([query, docs]) => [query, [...docs]]),
      search.results,
    );
  });
