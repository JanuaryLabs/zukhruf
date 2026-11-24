import { type EmbeddingModel, embed, embedMany } from 'ai';

import { DimensionMismatchError, Vector } from '@zukhruf/vectors';
import { fromSql, sqlType, toSql } from '@zukhruf/vectors/sqlserver';

import type { BatchRetriever } from '../batch-retriever.ts';
import {
  type ModelIdentity,
  describe,
  modelName,
  parseModelIdentity,
} from '../model-identity.ts';
import { ModelMismatchError } from '../model-mismatch-error.ts';
import type { RetrieveOptions } from '../retrieve-options.ts';
import type { ScoredPassage } from '../scored-passage.ts';
import { binary } from './binary.ts';
import { bind } from './bind.ts';
import { passage, passageJson } from './passage-row.ts';
import {
  type SqlServerPassageStore,
  contractOf,
} from './sqlserver-passage-store.ts';
import type { SqlServerSession } from './sqlserver-session.ts';
import { where } from './where.ts';

/**
 * Ranks the passages by the cosine similarity of their vectors to the query,
 * with `VECTOR_DISTANCE` in the SQL of SQL Server 2025 (ADR 0003). The search
 * is exact: `VECTOR_DISTANCE` uses no vector index.
 */
export class SqlServerEmbeddingRetriever implements BatchRetriever {
  readonly #session: SqlServerSession;
  readonly #passages: string;
  readonly #vectors: string;
  readonly #model: EmbeddingModel;

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
    this.#model = options.model;
  }

  async retrieve(
    query: string,
    options: RetrieveOptions = {},
  ): Promise<ScoredPassage[]> {
    const [passages] = await this.#retrieve(1, options, async (abortSignal) => {
      const { embedding } = await embed({
        model: this.#model,
        value: query,
        ...(abortSignal === undefined ? {} : { abortSignal }),
      });
      return [embedding];
    });
    return passages ?? [];
  }

  async retrieveMany(
    queries: readonly string[],
    options: RetrieveOptions = {},
  ): Promise<ScoredPassage[][]> {
    if (queries.length === 0) return [];
    return this.#retrieve(queries.length, options, async (abortSignal) => {
      const { embeddings } = await embedMany({
        model: this.#model,
        values: [...queries],
        ...(abortSignal === undefined ? {} : { abortSignal }),
      });
      return embeddings;
    });
  }

  async #retrieve(
    count: number,
    options: RetrieveOptions,
    embedQueries: (abortSignal?: AbortSignal) => Promise<readonly number[][]>,
  ): Promise<ScoredPassage[][]> {
    options.abortSignal?.throwIfAborted();
    const query = modelName(this.#model);
    const stored = await this.#storedIdentities();
    const [first] = stored;
    if (first === undefined) return Array.from({ length: count }, () => []);
    // A vector column has its dimensions in its type, `VECTOR(n)`, so the
    // table holds one identity of a model, unlike SQLite and Postgres.
    const identity = stored.find(
      ({ provider, modelId }) =>
        provider === query.provider && modelId === query.modelId,
    );
    if (identity === undefined) {
      throw new ModelMismatchError(
        { provider: first.provider, modelId: first.modelId },
        query,
      );
    }

    const vectors = await embedQueries(options.abortSignal);
    options.abortSignal?.throwIfAborted();
    const dimensions = vectors[0]?.length ?? 0;
    if (dimensions !== identity.dimensions) {
      throw new DimensionMismatchError(identity.dimensions, dimensions);
    }
    return this.#search(vectors, identity, options);
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
    options: RetrieveOptions,
  ): Promise<ScoredPassage[][]> {
    const parameters: Record<string, unknown> = {};
    const queries = bind(
      parameters,
      `[${vectors.map((vector) => toSql(Vector.from(vector))).join(',')}]`,
    );
    const model = bind(parameters, describe(identity));
    const filter = where(options.filter, parameters);
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
    const lists = vectors.map((): ScoredPassage[] => []);
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
