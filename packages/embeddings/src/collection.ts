import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { type EmbeddingModel, embedMany } from 'ai';

import { transaction } from '@zukhruf/sqlite-transaction';

import { DimensionMismatchError } from './dimension-mismatch-error.ts';
import { collectionSchema } from './schema.ts';
import { UnknownDocumentError } from './unknown-document-error.ts';
import { UnitVector } from './vector.ts';

const DAY_MS = 86_400_000;

export type Document = {
  readonly id: string;
  // The text that the model embeds. The caller chooses it.
  readonly text: string;
  readonly publishedAt: Date;
};

export type Neighbour = {
  readonly id: string;
  readonly similarity: number;
};

export type CollectionOptions = {
  // The caller opens and closes the database.
  readonly database: DatabaseSync;
  // A model object. A model id string goes through the global default
  // provider, so the collection cannot name its provider (docs/adr/0002).
  readonly model: Exclude<EmbeddingModel, string>;
};

// The embeddings of documents, one vector for each document, in a SQLite
// database. A search compares the document with each document published
// inside the window, with no index (docs/adr/0001).
export class Collection {
  readonly #database: DatabaseSync;
  readonly #model: Exclude<EmbeddingModel, string>;

  constructor(options: CollectionOptions) {
    this.#database = options.database;
    this.#model = options.model;
    collectionSchema.apply(this.#database);
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

  // The k documents most similar to the document, by cosine similarity, from
  // those published at most withinDays before or after it. The document
  // itself is not one of them. Equal similarities sort by id.
  nearest(
    id: string,
    options: { readonly k: number; readonly withinDays: number },
  ): Neighbour[] {
    const { vector, publishedAt } = this.#read(id);
    const window = options.withinDays * DAY_MS;
    const candidates = this.#database
      .prepare(
        'SELECT "id", "vector" FROM "embedding_document" WHERE "published_at" BETWEEN ? AND ? AND "id" != ?',
      )
      .all(publishedAt - window, publishedAt + window, id)
      .map((row) => ({
        id: String(row.id),
        vector: UnitVector.fromBlob(blob(row.vector)),
      }));
    return ranked(vector, candidates, options.k);
  }

  // The k nearest neighbours of each document published from `from` to `to`.
  // Each entry is what nearest gives for the document with the same k and
  // withinDays. The call reads and decodes each vector once
  // (docs/adr/0004). The entries come in the order of the publish dates, then
  // of the ids.
  neighbourGraph(options: {
    readonly from: Date;
    readonly to: Date;
    readonly k: number;
    readonly withinDays: number;
  }): IteratorObject<[string, Neighbour[]]> {
    const from = options.from.getTime();
    const to = options.to.getTime();
    const window = options.withinDays * DAY_MS;
    const documents = this.#database
      .prepare(
        'SELECT "id", "published_at", "vector" FROM "embedding_document" WHERE "published_at" BETWEEN ? AND ? ORDER BY "published_at", "id"',
      )
      .all(from - window, to + window)
      .map((row) => ({
        id: String(row.id),
        publishedAt: Number(row.published_at),
        vector: UnitVector.fromBlob(blob(row.vector)),
      }));
    return documents
      .values()
      .filter(({ publishedAt }) => publishedAt >= from && publishedAt <= to)
      .map((document) => [
        document.id,
        ranked(
          document.vector,
          documents.filter(
            (other) =>
              other.id !== document.id &&
              Math.abs(other.publishedAt - document.publishedAt) <= window,
          ),
          options.k,
        ),
      ]);
  }

  // The cosine similarity of two stored documents.
  similarity(a: string, b: string): number {
    return this.#read(a).vector.cosine(this.#read(b).vector);
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

  #read(id: string): { vector: UnitVector; publishedAt: number } {
    const row = this.#database
      .prepare(
        'SELECT "vector", "published_at" FROM "embedding_document" WHERE "id" = ?',
      )
      .get(id);
    if (row === undefined) throw new UnknownDocumentError(id);
    return {
      vector: UnitVector.fromBlob(blob(row.vector)),
      publishedAt: Number(row.published_at),
    };
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

// The k candidates most similar to the vector. Equal similarities sort by id.
function ranked(
  vector: UnitVector,
  candidates: readonly { readonly id: string; readonly vector: UnitVector }[],
  k: number,
): Neighbour[] {
  return candidates
    .map((candidate) => ({
      id: candidate.id,
      similarity: vector.cosine(candidate.vector),
    }))
    .toSorted(
      (left, right) =>
        right.similarity - left.similarity || compareIds(left.id, right.id),
    )
    .slice(0, k);
}

// Compares by code unit, not by locale, so the order is the same on every
// machine.
function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function blob(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array))
    throw new TypeError('A stored vector must be a BLOB.');
  return value;
}
