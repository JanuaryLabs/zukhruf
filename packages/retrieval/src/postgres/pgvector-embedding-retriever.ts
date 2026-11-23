import { type EmbeddingModel, embed, embedMany } from 'ai';
import { fromSql, toSql } from 'pgvector';

import { DimensionMismatchError } from '@zukhruf/vectors';

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
import { bind } from './bind.ts';
import { identifier } from './identifier.ts';
import { passage, passageJson } from './passage-row.ts';
import type { PostgresSession } from './postgres-session.ts';
import { where } from './where.ts';

/**
 * Ranks the passages by the cosine similarity of their vectors to the query,
 * with pgvector's `<=>` in the SQL of Postgres (ADR 0003).
 */
export class PgvectorEmbeddingRetriever implements BatchRetriever {
  readonly #session: PostgresSession;
  readonly #passages: string;
  readonly #vectors: string;
  readonly #model: EmbeddingModel;

  constructor(options: {
    readonly session: PostgresSession;
    readonly passages: string;
    readonly vectors: string;
    readonly model: EmbeddingModel;
  }) {
    this.#session = options.session;
    this.#passages = identifier(options.passages);
    this.#vectors = identifier(options.vectors);
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
    const sameModel = stored.filter(
      ({ provider, modelId }) =>
        provider === query.provider && modelId === query.modelId,
    );
    const [nearest] = sameModel;
    if (nearest === undefined) {
      throw new ModelMismatchError(
        { provider: first.provider, modelId: first.modelId },
        query,
      );
    }

    const vectors = await embedQueries(options.abortSignal);
    options.abortSignal?.throwIfAborted();
    const dimensions = vectors[0]?.length ?? 0;
    const identity = sameModel.find(
      (candidate) => candidate.dimensions === dimensions,
    );
    if (identity === undefined) {
      throw new DimensionMismatchError(nearest.dimensions, dimensions);
    }
    return this.#search(vectors, identity, options);
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
    const filter = where(options.filter, parameters);
    const topK = bind(parameters, options.topK ?? 10);
    const rows = await this.#session.query(
      `
      WITH "queries" ("query", "vector") AS (VALUES ${queries})
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
