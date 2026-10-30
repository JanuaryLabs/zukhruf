import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EmbeddingModelV4 } from '@ai-sdk/provider';

import { TemporaryFiles } from '@zukhruf/testing/fs';
import { HttpServer } from '@zukhruf/testing/http';

import { evaluate } from '../../evaluate.ts';
import { ArguAna } from '../../tasks/retrieval/eng/argu-ana-retrieval.ts';
import { embeddingGemma2 } from './google-embeddinggemma.ts';
import { qwen3Embedding0B6 } from './qwen3-models.ts';

// A dataset in the layout of mteb/arguana, served as the Hub serves it.
const FILES: Readonly<Record<string, string>> = {
  'README.md': `---
configs:
  - config_name: default
    data_files: [{ split: test, path: qrels/test.jsonl }]
  - config_name: corpus
    data_files: [{ split: corpus, path: corpus.jsonl }]
  - config_name: queries
    data_files: [{ split: queries, path: queries.jsonl }]
---
`,
  'corpus.jsonl': `${JSON.stringify({ _id: 'd1', title: 'Cats', text: 'Cats sleep.' })}\n${JSON.stringify({ _id: 'd2', title: '', text: 'Dogs bark.' })}`,
  'queries.jsonl': JSON.stringify({ _id: 'q1', text: 'Do cats sleep?' }),
  'qrels/test.jsonl': JSON.stringify({
    'query-id': 'q1',
    'corpus-id': 'd1',
    score: 1,
  }),
};

// The HuggingFace Hub cannot be reached in CI.
async function hub(): Promise<{
  readonly origin: string;
  [Symbol.asyncDispose](): Promise<void>;
}> {
  const server = await new HttpServer().start((request, response) => {
    const path = /\/resolve\/[0-9a-f]+\/(.+)$/u.exec(request.url ?? '')?.[1];
    const file = path === undefined ? undefined : FILES[path];
    response.statusCode = file === undefined ? 404 : 200;
    response.end(file ?? 'Not found');
  });
  return {
    origin: server.origin,
    [Symbol.asyncDispose]: () => server.cleanup(),
  };
}

// A served model cannot run in CI. This one implements the AI SDK interface,
// records each text it embeds, and gives a vector from the length of the text.
function recordingModel(): {
  readonly model: EmbeddingModelV4;
  readonly texts: string[];
} {
  const texts: string[] = [];
  return {
    texts,
    model: {
      specificationVersion: 'v4',
      provider: 'test',
      modelId: 'recorder',
      maxEmbeddingsPerCall: undefined,
      supportsParallelCalls: true,
      async doEmbed({ values }) {
        texts.push(...values);
        return {
          embeddings: values.map((value) => [value.length, 1]),
          usage: { tokens: values.length },
          warnings: [],
        };
      },
    },
  };
}

test('EmbeddingGemma 2 embeds a query as "task: <instruction of the task> | query:" and a document as "title: <title or none> | text:"', async () => {
  await using server = await hub();
  await using cache = await new TemporaryFiles().directory('mteb-models-');
  const { model, texts } = recordingModel();
  const encoder = embeddingGemma2.loadModel(model);

  await evaluate(
    encoder,
    new ArguAna({ hub: { endpoint: server.origin, cacheFolder: cache.path } }),
    { cache: null },
  );

  assert.deepEqual(texts, [
    'task: fact checking | query: Do cats sleep?',
    'title: Cats | text: Cats sleep.',
    'title: none | text: Dogs bark.',
  ]);
  assert.deepEqual(encoder.mtebModelMeta.modalities, ['text']);
});

test('Qwen3-Embedding puts "Instruct: <prompt of the task>\\nQuery:" before a query and nothing before a document', async () => {
  await using server = await hub();
  await using cache = await new TemporaryFiles().directory('mteb-models-');
  const { model, texts } = recordingModel();

  await evaluate(
    qwen3Embedding0B6.loadModel(model),
    new ArguAna({ hub: { endpoint: server.origin, cacheFolder: cache.path } }),
    { cache: null },
  );

  assert.deepEqual(texts, [
    'Instruct: Given a claim, find documents that refute the claim\nQuery:Do cats sleep?',
    'Cats Cats sleep.',
    'Dogs bark.',
  ]);
});

test('loadModel makes the keyword arguments with a value the experiment arguments of the encoder', () => {
  const { model } = recordingModel();

  const encoder = qwen3Embedding0B6.loadModel(model, {
    quantization: 'Q8_0',
    unused: '',
  });

  assert.deepEqual(encoder.mtebModelMeta.experimentKwargs, {
    quantization: 'Q8_0',
  });
  assert.equal(qwen3Embedding0B6.experimentKwargs, null);
});
