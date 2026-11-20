# Recipe: Test code that uses a collection with a mock model

**Use case.** Your code takes a `Collection`, and you want to test it. A real model cannot run in CI, because it needs a server and gives vectors that change with its version. `MockEmbeddingModelV4` of `ai/test`, the mock model of the AI SDK, takes the place of the model: it gives the vector that the test names for each text, so each similarity is a number that the test knows. The tests of this package and of `@zukhruf/relevance-filtering` and `@zukhruf/event-detection` make their collections this way (`src/collection.test.ts`, `packages/information-filtering/relevance-filtering/src/similarity-scorer.test.ts`, `packages/information-filtering/event-detection/src/event-detector.test.ts`).

**What you need.** `Collection`, `MockEmbeddingModelV4` of `ai/test`, a SQLite database in memory from `node:sqlite`, and `node:test`. The program needs no server and no model.

## The steps

1. Give each text of the test a vector, in a record from the text to the vector.
2. Make a `MockEmbeddingModelV4` whose `doEmbed` gives the vector of each text, and throws for a text that the record does not name.
3. Set `maxEmbeddingsPerCall: Infinity`, so that one upsert is one call to the model.
4. Open a new database with `new DatabaseSync(':memory:')` in each test, and give it and the mock model to `new Collection({ database, model })`.
5. Read `doEmbedCalls` of the mock model to see which texts the collection embedded.

## The program

The code under test is `relatedStories`: it gives the neighbours of a document with a similarity of at least 0.9. The three tests check its result, check that an upsert calls the model only for a new text, and check that an upsert with a text that has no vector stores no document.

```ts title="related-stories.test.ts"
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { MockEmbeddingModelV4 } from 'ai/test';

import { Collection } from '@zukhruf/embeddings';

// The code under test: the stories of the same week that are about the same
// thing as a story.
function relatedStories(collection: Collection, id: string): string[] {
  return collection
    .nearest(id, { k: 10, withinDays: 7 })
    .filter(({ similarity }) => similarity >= 0.9)
    .map((neighbour) => neighbour.id);
}

// The mock model gives the vector that the test names for each text, and
// fails on a text that the test did not name.
function model(
  vectors: Record<string, readonly number[]>,
): MockEmbeddingModelV4 {
  return new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: Infinity,
    doEmbed: async ({ values }) => ({
      embeddings: values.map((text) => {
        const vector = vectors[text];
        if (vector === undefined)
          throw new Error(`The test names no vector for "${text}"`);
        return [...vector];
      }),
      warnings: [],
    }),
  });
}

const vectors = {
  'Storm closes the port': [1, 0],
  'Port shut as storm hits': [0.96, 0.28],
  'Port opens again': [0.6, 0.8],
  'Swim club wins': [0, 1],
  'Port opens again after the storm': [0.8, 0.6],
};

const stories = [
  {
    id: 'storm',
    text: 'Storm closes the port',
    publishedAt: new Date('2026-10-20'),
  },
  {
    id: 'shut',
    text: 'Port shut as storm hits',
    publishedAt: new Date('2026-10-21'),
  },
  {
    id: 'opens',
    text: 'Port opens again',
    publishedAt: new Date('2026-10-22'),
  },
  { id: 'swim', text: 'Swim club wins', publishedAt: new Date('2026-10-22') },
];

test('a related story has a similarity of at least 0.9', async () => {
  using database = new DatabaseSync(':memory:');
  const collection = new Collection({ database, model: model(vectors) });
  await collection.upsert(stories);

  console.log(
    'nearest:',
    collection.nearest('storm', { k: 10, withinDays: 7 }),
  );
  assert.deepEqual(relatedStories(collection, 'storm'), ['shut']);
});

test('an upsert calls the model only for a new or changed text', async () => {
  using database = new DatabaseSync(':memory:');
  const fake = model(vectors);
  const collection = new Collection({ database, model: fake });
  await collection.upsert(stories);
  await collection.upsert([
    { ...stories[0]!, publishedAt: new Date('2026-10-23') },
    {
      id: 'opens',
      text: 'Port opens again after the storm',
      publishedAt: new Date('2026-10-22'),
    },
  ]);

  const calls = fake.doEmbedCalls.map(({ values }) => values);
  console.log('model calls:', calls);
  assert.deepEqual(calls, [
    stories.map(({ text }) => text),
    ['Port opens again after the storm'],
  ]);
});

test('a text with no vector fails the upsert, and the collection stores none of its documents', async () => {
  using database = new DatabaseSync(':memory:');
  const collection = new Collection({ database, model: model(vectors) });

  await assert.rejects(
    collection.upsert([
      stories[0]!,
      {
        id: 'new',
        text: 'Ferry runs late',
        publishedAt: new Date('2026-10-20'),
      },
    ]),
    (error) => {
      console.log('upsert:', Error.isError(error) ? error.message : error);
      return true;
    },
  );
  assert.equal(collection.count(), 0);
});
```

Run it from a folder with the workspace's `node_modules` linked into it, as `node --conditions=@zukhruf/source related-stories.test.ts`.

Output (the durations change from run to run):

```
nearest: [
  { id: 'shut', similarity: 0.9599999785423279 },
  { id: 'opens', similarity: 0.6000000238418579 },
  { id: 'swim', similarity: 0 }
]
model calls: [
  [
    'Storm closes the port',
    'Port shut as storm hits',
    'Port opens again',
    'Swim club wins'
  ],
  [ 'Port opens again after the storm' ]
]
upsert: The test names no vector for "Ferry runs late"
✔ a related story has a similarity of at least 0.9 (19.690375ms)
✔ an upsert calls the model only for a new or changed text (1.12025ms)
✔ a text with no vector fails the upsert, and the collection stores none of its documents (0.625792ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 35.971084
```

## What the output shows

- The vectors of the mock model are unit vectors, so each similarity is the dot product of two of them: 0.96 for `shut` and 0.6 for `opens`. The collection stores float32 values, so the similarity is `0.9599999785423279`, not `0.96`. Compare a similarity with a bound, as `relatedStories` does, and not with `assert.equal`.
- The first upsert called the model once, with the four texts. The second upsert gave `storm` a new publish date and `opens` a new text, and called the model only for the new text. The collection embeds through the embedding cache, so an unchanged text calls no model (#3134, commit `ba803520`).
- The mock model threw for `Ferry runs late`. The upsert rejected with that error, and `count()` gave 0: the collection stored no document of the upsert, also not `storm`, whose text has a vector.

## Things to know

- **The default of `maxEmbeddingsPerCall` in `ai/test` is 1.** With that default, `embedMany` calls the model once for each text, and `doEmbedCalls` has one entry for each text (`MockEmbeddingModelV4` in `node_modules/ai/dist/test/index.js`).
- **The embedding cache is in the database of the collection.** A new database in each test starts with an empty cache, so the first upsert of a test calls the model for each text. A new collection on the same database file does not embed an unchanged text again (`src/collection.test.ts`).
- **The cache names the model by its provider and its model id.** The defaults of the mock model are `mock-provider` and `mock-model-id`. Give another `provider` or `modelId` to test a change of model: the collection then embeds an unchanged text again (`src/collection.test.ts`, [ADR 0002](../adr/0002-the-hash-includes-the-model.md)).
- **A vector of another dimension fails the upsert.** Give all texts of one collection vectors with one dimension, or the upsert rejects with the `DimensionMismatchError` of `@zukhruf/vectors` ([ADR 0003](../adr/0003-all-vectors-of-a-collection-have-one-dimension.md)).
- **To decide on the similarities, choose the vectors by their angle.** The unit vector at an angle of θ degrees to `[1, 0]` is `[cos θ, sin θ]`, and its similarity to `[1, 0]` is `cos θ` (`packages/information-filtering/relevance-filtering/src/similarity-scorer.test.ts`).
