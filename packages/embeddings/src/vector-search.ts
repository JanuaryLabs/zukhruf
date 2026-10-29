import type { DatabaseSync } from 'node:sqlite';

import { DimensionMismatchError } from './dimension-mismatch-error.ts';
import { UnknownDocumentError } from './unknown-document-error.ts';
import { UnitVector, blob } from './vector.ts';

const DAY_MS = 86_400_000;

export type Neighbour = {
  readonly id: string;
  readonly similarity: number;
};

export type VectorSearchOptions = {
  // The caller opens and closes the database.
  readonly database: DatabaseSync;
  // A table or a view with the columns id, vector (a unit vector of float32
  // values in the byte order of the platform) and published_at (milliseconds
  // since the Unix epoch) (docs/adr/0005).
  readonly table: string;
};

// The neighbours of the documents in a vector table. A search compares the
// document with each document published inside the window, with no index
// (docs/adr/0001). Each call prepares its statements, so the table can come
// after the search.
export class VectorSearch {
  readonly #database: DatabaseSync;
  readonly #table: string;

  constructor(options: VectorSearchOptions) {
    this.#database = options.database;
    this.#table = `"${options.table.replaceAll('"', '""')}"`;
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
        `SELECT "id", "vector" FROM ${this.#table} WHERE "published_at" BETWEEN ? AND ? AND "id" != ?`,
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
        `SELECT "id", "published_at", "vector" FROM ${this.#table} WHERE "published_at" BETWEEN ? AND ? ORDER BY "published_at", "id"`,
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

  // The similarity of a vector from outside the table to each document
  // published from `from` to `to`, the highest first. Equal similarities sort
  // by id (docs/adr/0006).
  query(
    vector: readonly number[],
    options: { readonly from: Date; readonly to: Date },
  ): Neighbour[] {
    const query = UnitVector.normalize(vector);
    const stored = this.#database
      .prepare(`SELECT length("vector") AS "bytes" FROM ${this.#table} LIMIT 1`)
      .get();
    if (stored === undefined) return [];
    const dimension = Number(stored.bytes) / Float32Array.BYTES_PER_ELEMENT;
    if (dimension !== query.dimension)
      throw new DimensionMismatchError(dimension, query.dimension);
    const documents = this.#database
      .prepare(
        `SELECT "id", "vector" FROM ${this.#table} WHERE "published_at" BETWEEN ? AND ?`,
      )
      .all(options.from.getTime(), options.to.getTime())
      .map((row) => ({
        id: String(row.id),
        vector: UnitVector.fromBlob(blob(row.vector)),
      }));
    return ranked(query, documents, documents.length);
  }

  // The cosine similarity of two documents.
  similarity(a: string, b: string): number {
    return this.#read(a).vector.cosine(this.#read(b).vector);
  }

  #read(id: string): { vector: UnitVector; publishedAt: number } {
    const row = this.#database
      .prepare(
        `SELECT "vector", "published_at" FROM ${this.#table} WHERE "id" = ?`,
      )
      .get(id);
    if (row === undefined) throw new UnknownDocumentError(id);
    return {
      vector: UnitVector.fromBlob(blob(row.vector)),
      publishedAt: Number(row.published_at),
    };
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
