import type { EmbeddingModel } from 'ai';

import { Vector } from '@zukhruf/vectors';
import { fromSql, sqlType, toSql } from '@zukhruf/vectors/sqlserver';

import type { BatchRetriever } from '../batch-retriever.ts';
import { IdentityCheckedSearch } from '../identity-checked-search.ts';
import {
  type ModelIdentity,
  describe,
  parseModelIdentity,
} from '../model-identity.ts';
import type { StoredPassage } from '../passage.ts';
import type { QueryType } from '../query-bundle.ts';
import type { RetrievalResult } from '../retrieval-result.ts';
import type { RetrieveOptions } from '../retrieve-options.ts';
import type { ScoredPassage } from '../scored-passage.ts';
import { where } from '../sql/where.ts';
import { binary } from './binary.ts';
import { bind } from './bind.ts';
import { dialect } from './dialect.ts';
import { passage, passageJson } from './passage-row.ts';
import {
  type SqlServerPassageStore,
  contractOf,
} from './sqlserver-passage-store.ts';
import type { SqlServerSession } from './sqlserver-session.ts';

/**
 * Ranks the passages by the cosine similarity of their vectors to the query,
 * with `VECTOR_DISTANCE` in the SQL of SQL Server 2025 (ADR 0003). The search
 * is exact: `VECTOR_DISTANCE` uses no vector index.
 */
export class SqlServerEmbeddingRetriever implements BatchRetriever<StoredPassage> {
  readonly #session: SqlServerSession;
  readonly #passages: string;
  readonly #vectors: string;
  readonly #retrieval: IdentityCheckedSearch;

  constructor(options: {
    /** The store of the passages, whose session and schema the search uses. */
    readonly store: SqlServerPassageStore;
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

  async retrieve(
    query: QueryType,
    options: RetrieveOptions<StoredPassage> = {},
  ): Promise<RetrievalResult<StoredPassage>> {
    return {
      passages: await this.#retrieval.retrieve(query, options),
      failures: new Map(),
    };
  }

  async retrieveMany(
    queries: readonly QueryType[],
    options: RetrieveOptions<StoredPassage> = {},
  ): Promise<RetrievalResult<StoredPassage>[]> {
    const lists = await this.#retrieval.retrieveMany(queries, options);
    return lists.map((passages) => ({ passages, failures: new Map() }));
  }

  /** The identities of the stored vectors, in binary order of their text, as SQLite orders text. */
  async #storedIdentities(): Promise<ModelIdentity[]> {
    const rows = await this.#session.query(
      `SELECT DISTINCT v.[model] ${binary} AS [model] FROM ${this.#vectors} v ORDER BY 1`,
      {},
    );
    return rows.map(({ model }) => parseModelIdentity(String(model)));
  }

  /**
   * One SQL statement for every query vector: the query vectors are one JSON
   * parameter that `OPENJSON` reads, so a batch of any size stays under the
   * 2,100 parameters of SQL Server, and each query runs its own ordered,
   * limited scan through `CROSS APPLY`. It compares a query only with the
   * vectors of its own model identity, skips a NULL vector, which would sort
   * first, and breaks a tie of distance by the passage id in binary order.
   */
  async #search(
    vectors: readonly (readonly number[])[],
    identity: ModelIdentity,
    options: RetrieveOptions<StoredPassage>,
  ): Promise<ScoredPassage<StoredPassage>[][]> {
    const parameters: Record<string, unknown> = {};
    const queries = bind(
      parameters,
      `[${vectors.map((vector) => toSql(Vector.from(vector))).join(',')}]`,
    );
    const model = bind(parameters, describe(identity));
    const filter = where(dialect, options.filter, parameters);
    const topK = bind(parameters, options.topK ?? 10);
    // A CAST target cannot be a parameter; sqlType checks the dimensions.
    const type = sqlType(Vector, identity.dimensions);
    const rows = await this.#session.query(
      `
      WITH [queries] AS (
        SELECT CONVERT(INT, j.[key]) AS [query], CAST(j.[value] AS ${type}) AS [vector]
        FROM OPENJSON(${queries}) j
      )
      SELECT q.[query], r.[distance], r.[vector], r.[passage]
      FROM [queries] q CROSS APPLY (
        SELECT TOP (${topK})
          VECTOR_DISTANCE('cosine', v.[vector], q.[vector]) AS [distance],
          CAST(v.[vector] AS NVARCHAR(MAX)) AS [vector],
          ${passageJson} AS [passage],
          p.[id] ${binary} AS [id]
        FROM ${this.#vectors} v JOIN ${this.#passages} p ON p.[id] = v.[id] ${binary}
        WHERE v.[model] = ${model} ${binary} AND v.[vector] IS NOT NULL AND ${filter}
        ORDER BY 1, 4
      ) r
      ORDER BY q.[query], r.[distance], r.[id]`,
      parameters,
    );
    const lists = vectors.map((): ScoredPassage<StoredPassage>[] => []);
    for (const cells of rows) {
      lists[Number(cells['query'])]?.push({
        passage: passage(cells['passage']),
        score: 1 - Number(cells['distance']),
        ...(options.includeVectors === true
          ? {
              vector: Array.from(
                fromSql(Vector, String(cells['vector'])).values,
              ),
            }
          : {}),
      });
    }
    return lists;
  }
}
