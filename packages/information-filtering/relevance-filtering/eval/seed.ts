import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Collection } from '@zukhruf/embeddings';

import { readArticles } from './answer-key.ts';
import { CACHE_FOLDER, type Text, collectionOf, frozenModel } from './cache.ts';

// Writes the cache of the eval from the research bundle of #3195: the title
// and the lead of each article, its frozen vector, and the vector of each
// description. The exam vectors come from the vector cache of the
// event-grouping eval, which embedded deepmind-outlets with the same model
// and the same vector text.
// Usage: node eval/seed.ts <relevance-profiles folder>
const [research] = process.argv.slice(2);
if (research === undefined)
  throw new Error('Usage: node eval/seed.ts <relevance-profiles folder>');
const biology = join(research, '..', 'relevance-biology');
const eventGrouping = join(
  import.meta.dirname,
  '../../../event-grouping/eval/cache/vectors/embeddinggemma-2/f61725d2f34c/deepmind-outlets.sqlite',
);

type Item = { id: string; title: string; lead: string };
type VectorRow = { id: string; set?: string; vector: number[] };

const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8'));
const rows = (path: string) => read<{ rows: VectorRow[] }>(path).rows;

const collectionVectors = new Map(
  rows(join(biology, 'pooled/vectors.json')).map((row) => [row.id, row.vector]),
);
for (const row of rows(join(biology, 'round-1/vectors.json')))
  if (row.set === 'realistic' && !collectionVectors.has(row.id))
    collectionVectors.set(row.id, row.vector);

const sources: Record<
  string,
  { items: string; vectors: () => ReadonlyMap<string, readonly number[]> }
> = {
  collection: {
    items: 'collection/items.json',
    vectors: () => collectionVectors,
  },
  fresh: {
    items: 'fresh/items.json',
    vectors: () =>
      new Map(
        rows(join(research, 'fresh/vectors.json')).map((r) => [r.id, r.vector]),
      ),
  },
  'fresh-2': {
    items: 'fresh-2/items.json',
    vectors: () =>
      new Map(
        rows(join(research, 'fresh-2/vectors.json')).map((r) => [
          r.id,
          r.vector,
        ]),
      ),
  },
  'fresh-3': {
    items: 'fresh-3/items.json',
    vectors: () =>
      new Map(
        rows(join(research, 'fresh-3/vectors.json')).map((r) => [
          r.id,
          r.vector,
        ]),
      ),
  },
  'fresh-4': {
    items: 'fresh-4/items.json',
    vectors: () =>
      new Map(
        rows(join(research, 'fresh-4/vectors.json')).map((r) => [
          r.id,
          r.vector,
        ]),
      ),
  },
  exam: {
    items: 'exam/items.json',
    vectors: () => {
      using database = new DatabaseSync(eventGrouping, { readOnly: true });
      const ids = readArticles('exam').map(({ id }) => id);
      const stored = new Collection({ database, model: frozenModel() }).fetch(
        ids,
      );
      return new Map([...stored].map(([id, vector]) => [id, [...vector]]));
    },
  },
};

mkdirSync(join(CACHE_FOLDER, 'texts'), { recursive: true });
for (const [set, source] of Object.entries(sources)) {
  const items = read<Item[]>(join(research, source.items));
  const texts: Record<string, Text> = Object.fromEntries(
    items.map(({ id, title, lead }) => [id, { title, lead }]),
  );
  writeFileSync(
    join(CACHE_FOLDER, 'texts', `${set}.json`),
    JSON.stringify(texts),
  );
  const vectors = source.vectors();
  const { database, collection } = collectionOf(set, vectors);
  using _ = database;
  await collection.upsert(
    readArticles(set).map(({ id, publishedAt }) => ({
      id,
      text: id,
      publishedAt,
    })),
  );
  console.log(`${set}: ${items.length} texts, ${collection.count()} vectors`);
}

const descriptions = rows(join(research, 'round-2/descriptions.json'));
writeFileSync(
  join(CACHE_FOLDER, 'descriptions.json'),
  JSON.stringify(Object.fromEntries(descriptions.map((r) => [r.id, r.vector]))),
);
console.log(`descriptions: ${descriptions.length}`);
