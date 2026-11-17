import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { embedMany, wrapEmbeddingModel } from 'ai';
import { MockEmbeddingModelV4 } from 'ai/test';

import { TemporaryFiles } from '@zukhruf/fs';
import { open } from '@zukhruf/sqlite-open';

import {
  type ReaderPrompt,
  embeddingGemmaPrompt,
  vectorCache,
} from '../index.ts';

type Embed = MockEmbeddingModelV4['doEmbed'];

// A model that embeds all texts of a call in one doEmbed call.
function model(
  doEmbed: Embed | Awaited<ReturnType<Embed>>[],
  { provider = 'mock-provider', modelId = 'mock-model-id' } = {},
): MockEmbeddingModelV4 {
  return new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: null,
    provider,
    modelId,
    doEmbed,
  });
}

// The raw vectors of a reader, and the vectors that Venn's
// DecisionService.embed gives for them (fixtures/generate.py).
const venn: {
  readonly prompts: Readonly<Record<ReaderPrompt, string>>;
  readonly texts: readonly string[];
  readonly raw: readonly number[][];
  readonly vectors: readonly number[][];
} = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/expected.json'), 'utf8'),
);

// Venn divides by the norm that numpy adds up in float32, in the order of its
// BLAS, and the package adds it up in float64: of the 6,912 values of the
// fixture, 3,748 are equal and the others differ by at most 2 units in the
// last place of float32 (measured 2026-11-14). The float16 step changes them
// by up to 4.8e-3, so 4 units in the last place still tell it apart.
const FLOAT32_TOLERANCE = 2 ** -21;

// A model that gives each text a vector of its own: [length of the text, 1].
function lengths(): MockEmbeddingModelV4 {
  return model(async ({ values }) => ({
    embeddings: values.map((value) => [value.length, 1]),
    warnings: [],
  }));
}

// The reader as a caller composes it: the prompt outside, the cache inside,
// around the model. Disposing it closes the database.
function reader(
  model: MockEmbeddingModelV4,
  path: string,
  prompt: ReaderPrompt = 'Classification',
) {
  const database = open(path);
  return {
    model: wrapEmbeddingModel({
      model,
      middleware: [embeddingGemmaPrompt(prompt), vectorCache({ database })],
    }),
    [Symbol.dispose]: () => database.close(),
  };
}

test('a vector that is not finite, a wrong count or ragged rows are refused, and nothing is stored', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const path = join(directory.path, 'cache.sqlite');
  const results: Awaited<ReturnType<Embed>>[] = [
    { embeddings: [[1, Number.NaN]], warnings: [] },
    { embeddings: [[1, 0]], warnings: [] },
    {
      embeddings: [
        [1, 0],
        [0, 1, 0],
      ],
      warnings: [],
    },
  ];
  const inputs = [['broken'], ['one', 'two'], ['short', 'long']];

  for (const [index, result] of results.entries()) {
    using stack = reader(model([result]), path);
    await assert.rejects(
      embedMany({ model: stack.model, values: inputs[index] ?? [] }),
      { name: 'InvalidEmbeddingError' },
    );
  }

  const working = model(async ({ values }) => ({
    embeddings: values.map(() => [3, 4]),
    warnings: [],
  }));
  using stack = reader(working, path);
  await embedMany({ model: stack.model, values: ['broken', 'one', 'short'] });
  assert.equal(working.doEmbedCalls[0]?.values.length, 3);
});

test('the model receives each text after the prefix of its EmbeddingGemma prompt', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  // The prompts of EmbeddingGemma 2 at Venn's pinned revision, from its
  // config_sentence_transformers.json (fixtures/generate.py).
  const prefixes = Object.entries(venn.prompts).filter(
    (entry): entry is [ReaderPrompt, string] => true,
  );

  for (const [prompt, prefix] of prefixes) {
    const embedding = lengths();
    using stack = reader(
      embedding,
      join(directory.path, `${prompt}.sqlite`),
      prompt,
    );
    await embedMany({ model: stack.model, values: ['a ticket'] });

    assert.deepEqual(embedding.doEmbedCalls[0]?.values, [`${prefix}a ticket`]);
  }
});

test('a text that the cache holds makes no model call and gives its first vector', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const embedding = lengths();
  using stack = reader(embedding, join(directory.path, 'cache.sqlite'));

  const first = await embedMany({ model: stack.model, values: ['a ticket'] });
  const second = await embedMany({ model: stack.model, values: ['a ticket'] });

  assert.equal(embedding.doEmbedCalls.length, 1);
  assert.deepEqual(second.embeddings, first.embeddings);
});

test('only the texts that the cache lacks go to the model, each one time, and each vector goes to its text', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const embedding = lengths();
  using stack = reader(embedding, join(directory.path, 'cache.sqlite'));
  const prefix = 'task: classification | query: ';
  await embedMany({ model: stack.model, values: ['bbbb'] });

  const { embeddings } = await embedMany({
    model: stack.model,
    values: ['a', 'bbbb', 'ccc', 'a', 'dd'],
  });

  assert.deepEqual(embedding.doEmbedCalls[1]?.values, [
    `${prefix}a`,
    `${prefix}ccc`,
    `${prefix}dd`,
  ]);
  const ratio = (vector: readonly number[] | undefined) =>
    (vector?.[0] ?? 0) / (vector?.[1] ?? 1);
  assert.deepEqual(
    embeddings.map((vector) => Math.round(ratio(vector))),
    [
      prefix.length + 1,
      prefix.length + 4,
      prefix.length + 3,
      prefix.length + 1,
      prefix.length + 2,
    ],
  );
});

test('the vectors equal the vectors of Venn: unit in float64, then float16, then a float32 unit', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const rows = new Map(
    venn.texts.map((text, index) => [text, venn.raw[index] ?? []]),
  );
  const prefix = 'task: classification | query: ';
  const embedding = model(async ({ values }) => ({
    embeddings: values.map(
      (value) => rows.get(value.slice(prefix.length)) ?? [],
    ),
    warnings: [],
  }));
  using stack = reader(embedding, join(directory.path, 'cache.sqlite'));

  const misses = await embedMany({
    model: stack.model,
    values: [...venn.texts],
  });
  const hits = await embedMany({ model: stack.model, values: [...venn.texts] });

  for (const { embeddings } of [misses, hits])
    for (const [row, expected] of venn.vectors.entries())
      for (const [index, value] of expected.entries()) {
        const got: number = embeddings[row]?.[index] ?? Number.NaN;
        assert.ok(
          Math.abs(got - value) <= FLOAT32_TOLERANCE * Math.abs(value),
          `vector ${row}, value ${index}: ${got} against Venn's ${value}`,
        );
      }
});

test('the same text from another model or under another prompt goes to the model', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const path = join(directory.path, 'cache.sqlite');
  const first = lengths();
  const ones: Embed = async ({ values }) => ({
    embeddings: values.map(() => [1, 1]),
    warnings: [],
  });
  const otherId = model(ones, { modelId: 'another-model-id' });
  const otherProvider = model(ones, { provider: 'another-provider' });
  const similarity = lengths();

  for (const [embedding, prompt] of [
    [first, 'Classification'],
    [otherId, 'Classification'],
    [otherProvider, 'Classification'],
    [similarity, 'SentenceSimilarity'],
  ] as const) {
    using stack = reader(embedding, path, prompt);
    await embedMany({ model: stack.model, values: ['a ticket'] });
  }

  for (const embedding of [first, otherId, otherProvider, similarity])
    assert.equal(embedding.doEmbedCalls.length, 1, embedding.provider);
});

test('a new reader on the same database file gives the stored vector', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const path = join(directory.path, 'cache.sqlite');
  const first = lengths();
  const later = lengths();
  let stored: readonly number[][];
  {
    using stack = reader(first, path);
    stored = (await embedMany({ model: stack.model, values: ['a ticket'] }))
      .embeddings;
  }

  using stack = reader(later, path);
  const { embeddings } = await embedMany({
    model: stack.model,
    values: ['a ticket'],
  });

  assert.equal(later.doEmbedCalls.length, 0);
  assert.deepEqual(embeddings, stored);
});

test('a call that the model answers gives its usage, and a call that the cache answers uses no token', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const embedding = model(async ({ values }) => ({
    embeddings: values.map(() => [3, 4]),
    usage: { tokens: 17 },
    warnings: [],
  }));
  using stack = reader(embedding, join(directory.path, 'cache.sqlite'));

  const miss = await embedMany({ model: stack.model, values: ['a ticket'] });
  const hit = await embedMany({ model: stack.model, values: ['a ticket'] });

  assert.deepEqual(miss.usage, { tokens: 17 });
  assert.deepEqual(hit.usage, { tokens: 0 });
});
