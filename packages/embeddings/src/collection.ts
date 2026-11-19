import type { DatabaseSync } from 'node:sqlite';

import { embedMany, wrapEmbeddingModel } from 'ai';

import { embeddingCacheMiddleware } from '@zukhruf/embedding-cache';
import { SqliteEmbeddingCacheStore } from '@zukhruf/embedding-cache/sqlite';
import { transaction } from '@zukhruf/sqlite-transaction';
import { DimensionMismatchError, UnitVector, Vector } from '@zukhruf/vectors';
import { fromSql, toSql } from '@zukhruf/vectors/sqlite';

import { collectionSchema } from './schema.ts';
import { UnknownDocumentError } from './unknown-document-error.ts';
import { type Neighbour, VectorSearch } from './vector-search.ts';
import { blob } from './vector.ts';

export type Document = {
  readonly id: string;
  // The text that the model embeds. The caller chooses it.
  readonly text: string;
  readonly publishedAt: Date;
};

export type CollectionOptions = {
  // The caller opens and closes the database.
  readonly database: DatabaseSync;
  // A model object. A model id string goes through the global default
  // provider, so the cache cannot name its provider (docs/adr/0002).
  readonly model: Parameters<typeof wrapEmbeddingModel>[0]['model'];
};

// The embeddings of documents, one vector for each document, in a SQLite
// database. The collection searches its table through a VectorSearch.
export class Collection {
  readonly #database: DatabaseSync;
  readonly #model: ReturnType<typeof wrapEmbeddingModel>;
  readonly #search: VectorSearch;

  constructor(options: CollectionOptions) {
    this.#database = options.database;
    // The cache in the same database calls the model only for a text that
    // this model did not embed before (docs/adr/0002).
    this.#model = wrapEmbeddingModel({
      model: options.model,
      middleware: embeddingCacheMiddleware({
        store: new SqliteEmbeddingCacheStore({
          database: this.#database,
          table: 'embedding_cache',
        }),
      }),
    });
    collectionSchema.apply(this.#database);
    this.#search = new VectorSearch({
      database: this.#database,
      table: 'embedding_document',
    });
  }

  // Embeds the text of each document through the cache, and stores its
  // vector and publish date.
  async upsert(documents: readonly Document[]): Promise<void> {
    const { embeddings } = await embedMany({
      model: this.#model,
      values: documents.map(({ text }) => text),
    });
    const vectors = embeddings.map((embedding) =>
      UnitVector.normalize(Vector.from(embedding)),
    );

    transaction(
      this.#database,
      () => {
        const write = this.#database.prepare(
          `INSERT INTO "embedding_document" ("id", "published_at", "vector") VALUES (?, ?, ?)
          ON CONFLICT ("id") DO UPDATE SET "published_at" = excluded."published_at", "vector" = excluded."vector"`,
        );
        // embedMany gives one embedding for each text, in their order.
        for (const [index, document] of documents.entries())
          write.run(
            document.id,
            document.publishedAt.getTime(),
            toSql(vectors[index]!),
          );
        this.#checkDimension(
          documents.map(({ id }) => id),
          vectors,
        );
      },
      { mode: 'immediate' },
    );
  }

  // The neighbours of a document (docs/adr/0005).
  nearest(
    id: string,
    options: { readonly k: number; readonly withinDays: number },
  ): Neighbour[] {
    return this.#search.nearest(id, options);
  }

  // The neighbours of each document published from `from` to `to`.
  neighbourGraph(options: {
    readonly from: Date;
    readonly to: Date;
    readonly k: number;
    readonly withinDays: number;
  }): IteratorObject<[string, Neighbour[]]> {
    return this.#search.neighbourGraph(options);
  }

  // The cosine similarity of two stored documents.
  similarity(a: string, b: string): number {
    return this.#search.similarity(a, b);
  }

  // The similarity of a vector of the caller to each document, or with a date
  // range to each document published from `from` to `to`, the highest first
  // (docs/adr/0006, docs/adr/0007).
  query(
    vector: readonly number[],
    range?: { readonly from: Date; readonly to: Date },
  ): Neighbour[] {
    return this.#search.query(vector, range);
  }

  // The stored unit vector of each id, in the order of the ids. One unknown id
  // fails the call (docs/adr/0006).
  fetch(ids: readonly string[]): Map<string, Float32Array> {
    const read = this.#database.prepare(
      'SELECT "vector" FROM "embedding_document" WHERE "id" = ?',
    );
    return new Map(
      ids.map((id) => {
        const row = read.get(id);
        if (row === undefined) throw new UnknownDocumentError(id);
        return [id, fromSql(Vector, blob(row.vector)).values];
      }),
    );
  }

  // Removes the documents. An id that the collection does not store is not an
  // error, so a second delete of the same ids does nothing (docs/adr/0006).
  delete(ids: readonly string[]): void {
    this.#database
      .prepare(
        'DELETE FROM "embedding_document" WHERE "id" IN (SELECT "value" FROM json_each(?))',
      )
      .run(JSON.stringify(ids));
  }

  // The number of stored documents.
  count(): number {
    const row = this.#database
      .prepare('SELECT count(*) AS "count" FROM "embedding_document"')
      .get();
    return Number(row?.count);
  }

  // Before the upsert, each stored vector has one dimension. The new vectors
  // must have the dimension of a vector that the upsert did not replace, and
  // of each other.
  #checkDimension(replaced: readonly string[], vectors: readonly Vector[]) {
    const [first] = vectors;
    if (first === undefined) return;
    const kept = this.#database
      .prepare(
        'SELECT length("vector") AS "bytes" FROM "embedding_document" WHERE "id" NOT IN (SELECT "value" FROM json_each(?)) LIMIT 1',
      )
      .get(JSON.stringify(replaced));
    const expected =
      kept === undefined
        ? first.dimensions
        : Number(kept.bytes) / Float32Array.BYTES_PER_ELEMENT;
    for (const vector of vectors)
      if (vector.dimensions !== expected)
        throw new DimensionMismatchError(expected, vector.dimensions);
  }
}
