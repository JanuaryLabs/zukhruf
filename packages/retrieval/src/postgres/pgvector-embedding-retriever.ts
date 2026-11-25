import type { EmbeddingModel } from 'ai';
import { fromSql, toSql } from 'pgvector';

import type { BatchRetriever } from '../batch-retriever.ts';
import { IdentityCheckedSearch } from '../identity-checked-search.ts';
import {
  type ModelIdentity,
  describe,
  parseModelIdentity,
} from '../model-identity.ts';
import type { QueryType } from '../query-bundle.ts';
import type { RetrieveOptions } from '../retrieve-options.ts';
import type { ScoredPassage } from '../scored-passage.ts';
import { where } from '../sql/where.ts';
import { bind } from './bind.ts';
import { dialect } from './dialect.ts';
import { passage, passageJson } from './passage-row.ts';
import {
  type PostgresPassageStore,
  contractOf,
} from './postgres-passage-store.ts';
import type { PostgresSession } from './postgres-session.ts';

/**
 * Ranks the passages by the cosine similarity of their vectors to the query,
 * with pgvector's `<=>` in the SQL of Postgres (ADR 0003).
 */
export class PgvectorEmbeddingRetriever implements BatchRetriever {
  readonly #session: PostgresSession;
  readonly #passages: string;
  readonly #vectors: string;
  readonly #retrieval: IdentityCheckedSearch;

  constructor(options: {
    /** The store of the passages, whose session and schema the search uses. */
    readonly store: PostgresPassageStore;
    /** The passage vectors, in the schema of the store. */
    readonly vectors: string;
    readonly model: EmbeddingModel;
  }) {
    const contract = contractOf(options.store);
    this.#session = contract.session;
    this.#passages = contract.passages;
    this.#vectors = contract.relation(options.vectors);
    this.#retrieval = new IdentityCheckedSearch({
      model: options.model,
      storedIdentities: () => this.#storedIdentities(),
      search: (vectors, identity, retrieveOptions) =>
        this.#search(vectors, identity, retrieveOptions),
    });
  }

  retrieve(
    query: QueryType,
    options: RetrieveOptions = {},
  ): Promise<ScoredPassage[]> {
    return this.#retrieval.retrieve(query, options);
  }

  retrieveMany(
    queries: readonly QueryType[],
    options: RetrieveOptions = {},
  ): Promise<ScoredPassage[][]> {
    return this.#retrieval.retrieveMany(queries, options);
  }

  /** The identities of the stored vectors, in the byte order of their text, as SQLite orders text. */
  async #storedIdentities(): Promise<ModelIdentity[]> {
    const rows = await this.#session.query(
      `SELECT DISTINCT "model" COLLATE "C" AS "model" FROM ${this.#vectors} ORDER BY 1`,
      [],
    );
    return rows.map(({ model }) => parseModelIdentity(String(model)));
  }

  /**
   * One SQL query for every query vector: each query runs its own ordered,
   * limited scan through `CROSS JOIN LATERAL`, the form that pgvector's index
   * serves for each row of the queries. It compares a query only with the
   * vectors of its own model identity, and breaks a tie of distance by the
   * passage id, as `VectorSearch` of `@zukhruf/embeddings` does.
   *
   * An HNSW index gives its nearest vectors before the model filter runs, so
   * a search for an identity of few rows would give fewer than topK. Each row
   * of the materialized queries sets pgvector's `hnsw.iterative_scan` to
   * `strict_order` for the transaction of the statement before the scan of
   * that row starts, so the scan goes on until topK rows pass the filter, in
   * the order of distance that the `LIMIT` of each row cuts (ADR 0003).
   */
  async #search(
    vectors: readonly (readonly number[])[],
    identity: ModelIdentity,
    options: RetrieveOptions,
  ): Promise<ScoredPassage[][]> {
    const parameters: unknown[] = [];
    const queries = vectors
      .map(
        (vector, index) =>
          `(${index}, ${bind(parameters, toSql([...vector]))}::vector)`,
      )
      .join(', ');
    const model = bind(parameters, describe(identity));
    const row = passageJson(parameters, this.#passages);
    const filter = where(dialect, options.filter, parameters);
    const topK = bind(parameters, options.topK ?? 10);
    const rows = await this.#session.query(
      `
      WITH "queries" AS MATERIALIZED (
        SELECT v."query", v."vector", set_config('hnsw.iterative_scan', 'strict_order', true) AS "scan"
        FROM (VALUES ${queries}) v ("query", "vector")
      )
      SELECT q."query", r."distance", r."vector", r."passage"
      FROM "queries" q CROSS JOIN LATERAL (
        SELECT v."vector" <=> q."vector" AS "distance", v."vector"::text AS "vector", ${row} AS "passage", p."id"::text COLLATE "C" AS "id"
        FROM ${this.#vectors} v JOIN ${this.#passages} p ON p."id" = v."id"
        WHERE v."model" = ${model} AND ${filter}
        ORDER BY v."vector" <=> q."vector", p."id"::text COLLATE "C"
        LIMIT ${topK}
      ) r
      ORDER BY q."query", r."distance", r."id"`,
      parameters,
    );
    const lists = vectors.map((): ScoredPassage[] => []);
    for (const cells of rows) {
      lists[Number(cells['query'])]?.push({
        passage: passage(cells['passage']),
        score: 1 - Number(cells['distance']),
        ...(options.includeVectors === true
          ? { vector: storedVector(cells['vector']) }
          : {}),
      });
    }
    return lists;
  }
}

function storedVector(cell: unknown): number[] {
  const vector = fromSql(String(cell));
  if (Array.isArray(vector)) return vector;
  throw new TypeError(
    `A stored vector is a pgvector vector, not ${String(cell)}`,
  );
}
