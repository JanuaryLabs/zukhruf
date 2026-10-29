import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MockEmbeddingModelV4 } from 'ai/test';

import { Collection } from '@zukhruf/embeddings';

import { EVAL_FOLDER } from './answer-key.ts';

// The texts, the vectors and the description vectors of the eval. The
// repository holds no publisher text; `node eval/seed.ts` writes the cache
// from the research bundle (README.md, "Cache").
export const CACHE_FOLDER = join(EVAL_FOLDER, 'cache');

export type Text = { readonly title: string; readonly lead: string };

// The frozen vectors of the research stand in for the model: no model runs
// in the eval. The text of each document is its article id, and the stand-in
// gives the frozen vector of that id. EmbeddingGemma 2 Q8_0 on llama.cpp
// b11836 made every vector (README.md, "Cache").
export function frozenModel(
  vectors: ReadonlyMap<string, readonly number[]> = new Map(),
): MockEmbeddingModelV4 {
  return new MockEmbeddingModelV4({
    provider: 'research',
    modelId: 'embeddinggemma-2-q8_0',
    maxEmbeddingsPerCall: Infinity,
    doEmbed: async ({ values }) => ({
      embeddings: values.map((id) => {
        const vector = vectors.get(id);
        if (vector === undefined)
          throw new Error(
            `The cache has no vector of ${id}. Seed the cache: node eval/seed.ts <research folder>.`,
          );
        return [...vector];
      }),
      warnings: [],
    }),
  });
}

// The collection of the vectors of a set. The caller disposes the database.
export function collectionOf(
  set: string,
  vectors?: ReadonlyMap<string, readonly number[]>,
): { readonly database: DatabaseSync; readonly collection: Collection } {
  mkdirSync(join(CACHE_FOLDER, 'vectors'), { recursive: true });
  const database = new DatabaseSync(
    join(CACHE_FOLDER, 'vectors', `${set}.sqlite`),
  );
  return {
    database,
    collection: new Collection({ database, model: frozenModel(vectors) }),
  };
}

export function textsOf(set: string): ReadonlyMap<string, Text> {
  const texts: Record<string, Text> = JSON.parse(
    readFileSync(join(CACHE_FOLDER, 'texts', `${set}.json`), 'utf8'),
  );
  return new Map(Object.entries(texts));
}

// The vector of the description of each profile, embedded with the query
// prompt of EmbeddingGemma: `task: search result | query: <description>`.
export function descriptionVectors(): ReadonlyMap<string, readonly number[]> {
  const vectors: Record<string, number[]> = JSON.parse(
    readFileSync(join(CACHE_FOLDER, 'descriptions.json'), 'utf8'),
  );
  return new Map(Object.entries(vectors));
}

// The text that the keywords are matched in: the title and the lead, as in
// the research.
export function keywordText(text: Text): string {
  return `${text.title} ${text.lead}`;
}
