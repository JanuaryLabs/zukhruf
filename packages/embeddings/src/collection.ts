import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { type EmbeddingModel, embedMany } from 'ai';

import { transaction } from '@zukhruf/sqlite-transaction';

import { DimensionMismatchError } from './dimension-mismatch-error.ts';
import { collectionSchema } from './schema.ts';
import { UnknownDocumentError } from './unknown-document-error.ts';
import { type Neighbour, VectorSearch } from './vector-search.ts';
import { UnitVector, blob } from './vector.ts';

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
  // provider, so the collection cannot name its provider (docs/adr/0002).
  readonly model: Exclude<EmbeddingModel, string>;
};

// The embeddings of documents, one vector for each document, in a SQLite
// database. The collection searches its table through a VectorSearch.
export class Collection {
  readonly #database: DatabaseSync;
  readonly #model: Exclude<EmbeddingModel, string>;
  readonly #search: VectorSearch;

  constructor(options: CollectionOptions) {
    this.#database = options.database;
    this.#model = options.model;
    collectionSchema.apply(this.#database);
    this.#search = new VectorSearch({
      database: this.#database,
      table: 'embedding_document',
    });
  }

  // Embeds the documents whose text or model changed since their last upsert,
  // and stores the publish date of each document.
  async upsert(documents: readonly Document[]): Promise<void> {
    const stored = this.#database.prepare(
      'SELECT "hash" FROM "embedding_document" WHERE "id" = ?',
    );
    const hashed = documents.map((document) => ({
      document,
      hash: this.#hash(document.text),
    }));
    const { changed = [], unchanged = [] } = Object.groupBy(
      hashed,
      ({ document, hash }) =>
        stored.get(document.id)?.hash === hash ? 'unchanged' : 'changed',
    );
    const vectors = await this.#embed(
      changed.map(({ document }) => document.text),
    );

    transaction(
      this.#database,
      () => {
        const write = this.#database.prepare(
          `INSERT INTO "embedding_document" ("id", "hash", "published_at", "vector") VALUES (?, ?, ?, ?)
          ON CONFLICT ("id") DO UPDATE SET "hash" = excluded."hash", "published_at" = excluded."published_at", "vector" = excluded."vector"`,
        );
        for (const [index, { document, hash }] of changed.entries()) {
          const vector = vectors[index];
          if (vector === undefined)
            throw new Error(
              `The model gave ${vectors.length} embeddings for ${changed.length} texts.`,
            );
          write.run(
            document.id,
            hash,
            document.publishedAt.getTime(),
            vector.toBlob(),
          );
        }
        const move = this.#database.prepare(
          'UPDATE "embedding_document" SET "published_at" = ? WHERE "id" = ?',
        );
        for (const { document } of unchanged)
          move.run(document.publishedAt.getTime(), document.id);
        this.#checkDimension(
          changed.map(({ document }) => document.id),
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
        return [id, UnitVector.fromBlob(blob(row.vector)).toFloat32Array()];
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

  // No texts make no call to the model.
  async #embed(texts: string[]): Promise<UnitVector[]> {
    if (texts.length === 0) return [];
    const { embeddings } = await embedMany({
      model: this.#model,
      values: texts,
    });
    return embeddings.map((embedding) => UnitVector.normalize(embedding));
  }

  // The model is part of the hash, so a new model embeds the text again.
  #hash(text: string): string {
    return createHash('sha256')
      .update(JSON.stringify([this.#model.provider, this.#model.modelId, text]))
      .digest('hex');
  }

  // Before the upsert, each stored vector has one dimension. The new vectors
  // must have the dimension of a vector that the upsert did not replace, and
  // of each other.
  #checkDimension(replaced: readonly string[], vectors: readonly UnitVector[]) {
    const [first] = vectors;
    if (first === undefined) return;
    const kept = this.#database
      .prepare(
        'SELECT length("vector") AS "bytes" FROM "embedding_document" WHERE "id" NOT IN (SELECT "value" FROM json_each(?)) LIMIT 1',
      )
      .get(JSON.stringify(replaced));
    const expected =
      kept === undefined
        ? first.dimension
        : Number(kept.bytes) / Float32Array.BYTES_PER_ELEMENT;
    for (const vector of vectors)
      if (vector.dimension !== expected)
        throw new DimensionMismatchError(expected, vector.dimension);
  }
}
