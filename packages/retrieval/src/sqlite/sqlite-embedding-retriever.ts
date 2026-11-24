import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import type { EmbeddingModel } from 'ai';

import { Vector } from '@zukhruf/vectors';
import { fromSql, toSql } from '@zukhruf/vectors/sqlite';

import type { BatchRetriever } from '../batch-retriever.ts';
import { IdentityCheckedSearch } from '../identity-checked-search.ts';
import {
  type ModelIdentity,
  describe,
  parseModelIdentity,
} from '../model-identity.ts';
import type { RetrieveOptions } from '../retrieve-options.ts';
import type { ScoredPassage } from '../scored-passage.ts';
import { identifier } from '../sql/identifier.ts';
import { where } from '../sql/where.ts';
import { dialect } from './dialect.ts';
import { passageRows } from './passage-rows.ts';
import { type SqlitePassageStore, contractOf } from './sqlite-passage-store.ts';

/**
 * Ranks the passages by the cosine similarity of their vectors to the query,
 * with `vec_distance_cosine` in the SQL of SQLite (ADR 0003). The host
 * registers that function: it loads sqlite-vec, or calls `install()` of
 * `@zukhruf/vectors/sqlite`.
 */
export class SqliteEmbeddingRetriever implements BatchRetriever {
  readonly #database: DatabaseSync;
  readonly #passages: string;
  readonly #vectors: string;
  readonly #retrieval: IdentityCheckedSearch;

  constructor(options: {
    /** The store of the passages, whose connection the search runs on. */
    readonly store: SqlitePassageStore;
    /** The passage vectors, in the database of the store. */
    readonly vectors: string;
    readonly model: EmbeddingModel;
  }) {
    const { database, passages } = contractOf(options.store);
    this.#database = database;
    this.#passages = passages;
    this.#vectors = identifier(options.vectors);
    this.#retrieval = new IdentityCheckedSearch({
      model: options.model,
      storedIdentities: () => this.#storedIdentities(),
      search: (vectors, identity, retrieveOptions) =>
        this.#search(vectors, identity, retrieveOptions),
    });
  }

  retrieve(
    query: string,
    options: RetrieveOptions = {},
  ): Promise<ScoredPassage[]> {
    return this.#retrieval.retrieve(query, options);
  }

  retrieveMany(
    queries: readonly string[],
    options: RetrieveOptions = {},
  ): Promise<ScoredPassage[][]> {
    return this.#retrieval.retrieveMany(queries, options);
  }

  /** The identities of the stored vectors, in the order of their text. */
  #storedIdentities(): ModelIdentity[] {
    return this.#database
      .prepare(`SELECT DISTINCT "model" FROM ${this.#vectors} ORDER BY "model"`)
      .all()
      .map(({ model }) => parseModelIdentity(String(model)));
  }

  /**
   * One SQL query for every query vector. It compares a query only with the
   * vectors of its own model identity, and breaks a tie of distance by the
   * passage id, as `VectorSearch` of `@zukhruf/embeddings` does.
   */
  #search(
    vectors: readonly (readonly number[])[],
    identity: ModelIdentity,
    options: RetrieveOptions,
  ): ScoredPassage[][] {
    const parameters: SQLInputValue[] = [
      ...vectors.flatMap((vector, index) => [
        index,
        toSql(Vector.from(vector)),
      ]),
      describe(identity),
    ];
    const filter = where(dialect, options.filter, parameters);
    parameters.push(options.topK ?? 10);
    const statement = this.#database.prepare(`
      WITH "queries" ("query", "vector") AS (VALUES ${vectors.map(() => '(?, ?)').join(', ')}),
      "scored" AS (
        SELECT q."query", v."id", v."vector", vec_distance_cosine(v."vector", q."vector") AS "distance"
        FROM "queries" q CROSS JOIN ${this.#vectors} v JOIN ${this.#passages} p ON p."id" = v."id"
        WHERE v."model" = ? AND ${filter}
      ),
      "ranked" AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY "query" ORDER BY "distance", "id") AS "rank" FROM "scored"
      )
      SELECT r."query", r."distance", r."vector", p.*
      FROM "ranked" r JOIN ${this.#passages} p ON p."id" = r."id"
      WHERE r."rank" <= ?
      ORDER BY r."query", r."rank"`);
    const rows = passageRows(statement, 3, parameters);
    const lists = vectors.map((): ScoredPassage[] => []);
    for (const {
      cells: [query, distance, vector],
      passage,
    } of rows) {
      lists[Number(query)]?.push({
        passage,
        score: 1 - Number(distance),
        ...(options.includeVectors === true
          ? { vector: Array.from(fromSql(Vector, blob(vector)).values) }
          : {}),
      });
    }
    return lists;
  }
}

function blob(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new TypeError(
    `A stored vector is a BLOB of float32 values, not ${String(value)}`,
  );
}
