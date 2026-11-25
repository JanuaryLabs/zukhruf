import type { EmbeddingModel } from 'ai';
import { fromSql, toSql } from 'pgvector';

import type { BatchRetriever } from '../batch-retriever.ts';
import { IdentityCheckedSearch } from '../identity-checked-search.ts';
import {
  type ModelIdentity,
  describe,
  parseModelIdentity,
} from '../model-identity.ts';
import type { Metadata, StoredPassage } from '../passage.ts';
import type { QueryType } from '../query-bundle.ts';
import type { RetrievalResult } from '../retrieval-result.ts';
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
 * It gives the passages with the metadata that its store reads (ADR 0015).
 */
export class PgvectorEmbeddingRetriever<
  // `in out M`: TypeScript cannot measure M through the filter's mapped keys,
  // and a class method checks its parameters both ways (ADR 0015).
  in out M extends Metadata = Metadata,
> implements BatchRetriever<StoredPassage<M>, ScoredPassage<StoredPassage<M>>> {
  readonly #session: PostgresSession;
  readonly #passages: string;
  readonly #metadata: (columns: Metadata) => M;
  readonly #vectors: string;
  readonly #retrieval: IdentityCheckedSearch<StoredPassage<M>>;

  constructor(options: {
    /** The store of the passages, whose session and schema the search uses. */
    readonly store: PostgresPassageStore<M>;
    /** The passage vectors, in the schema of the store. */
    readonly vectors: string;
    readonly model: EmbeddingModel;
    /** The least score, a cosine similarity from -1 to 1, that a passage keeps: every passage when absent (ADR 0019). */
    readonly scoreThreshold?: number;
  }) {
    const contract = contractOf(options.store);
    this.#session = contract.session;
    this.#passages = contract.passages;
    this.#metadata = contract.metadata;
    this.#vectors = contract.relation(options.vectors);
    this.#retrieval = new IdentityCheckedSearch({
      model: options.model,
      storedIdentities: (signal) => this.#storedIdentities(signal),
      search: (vectors, identity, retrieveOptions) =>
        this.#search(vectors, identity, retrieveOptions),
      scoreThreshold: options.scoreThreshold,
    });
  }

  async retrieve(
    query: QueryType,
    options: RetrieveOptions<StoredPassage<M>> = {},
  ): Promise<
    RetrievalResult<StoredPassage<M>, ScoredPassage<StoredPassage<M>>>
  > {
    return {
      passages: await this.#retrieval.retrieve(query, options),
      failures: new Map(),
    };
  }

  async retrieveMany(
    queries: readonly QueryType[],
    options: RetrieveOptions<StoredPassage<M>> = {},
  ): Promise<
    RetrievalResult<StoredPassage<M>, ScoredPassage<StoredPassage<M>>>[]
  > {
    const lists = await this.#retrieval.retrieveMany(queries, options);
    return lists.map((passages) => ({ passages, failures: new Map() }));
  }

  /** The identities of the stored vectors, in the byte order of their text, as SQLite orders text. */
  async #storedIdentities(
    signal: AbortSignal | undefined,
  ): Promise<ModelIdentity[]> {
    const rows = await this.#session.query(
      `SELECT DISTINCT "model" COLLATE "C" AS "model" FROM ${this.#vectors} ORDER BY 1`,
      [],
      signal === undefined ? {} : { signal },
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
    options: RetrieveOptions<StoredPassage<M>>,
  ): Promise<ScoredPassage<StoredPassage<M>>[][]> {
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
      options.signal === undefined ? {} : { signal: options.signal },
    );
    const lists = vectors.map((): ScoredPassage<StoredPassage<M>>[] => []);
    for (const cells of rows) {
      lists[Number(cells['query'])]?.push({
        passage: passage(cells['passage'], this.#metadata),
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
