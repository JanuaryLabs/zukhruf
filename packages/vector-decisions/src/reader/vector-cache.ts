import { hash } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type { EmbeddingModelMiddleware } from 'ai';

import { Declaration } from '@zukhruf/sqlite-drift';
import { transaction } from '@zukhruf/sqlite-transaction';

import { InvalidEmbeddingError } from './invalid-embedding-error.ts';

// The smallest norm that Venn divides by (venn/reader.py unit).
const NORM_EPSILON = 1e-12;
const FLOAT16_BYTES = 2;

type Embed = NonNullable<EmbeddingModelMiddleware['wrapEmbed']>;
type Call = Parameters<Embed>[0];

// Keeps the vector of each text in a SQLite database, and asks the model
// only for the texts that it lacks, as Venn's DecisionService.embed does
// (venn/server.py:135). The caller opens and closes the database.
export function vectorCache(options: {
  readonly database: DatabaseSync;
}): EmbeddingModelMiddleware {
  const cache = new VectorCache(options.database);
  return {
    specificationVersion: 'v4',
    wrapEmbed: (embed) => cache.embed(embed),
  };
}

class VectorCache {
  // A Declaration opens a SQLite database when it is made, so the first
  // cache makes it, not the import of the package: a process whose
  // permissions forbid SQLite extensions can then import the package.
  static #schema: Declaration | undefined;

  readonly #database: DatabaseSync;
  readonly #read: StatementSync;
  readonly #write: StatementSync;

  constructor(database: DatabaseSync) {
    VectorCache.#declaration().apply(database);
    this.#database = database;
    this.#read = database.prepare(
      'SELECT vector FROM vector_cache WHERE key = ?',
    );
    this.#write = database.prepare(
      'INSERT OR IGNORE INTO vector_cache (key, vector) VALUES (?, ?)',
    );
  }

  async embed({ params, model }: Call): ReturnType<Embed> {
    // Unlike Venn's key, which names its one pinned reader, the key names the
    // model that makes the vector, because the model is the caller's.
    const keys = params.values.map((text) =>
      hash('sha256', JSON.stringify([model.provider, model.modelId, text])),
    );
    const stored = new Map<string, Uint8Array>();
    const missing = new Map<string, string>();
    for (const [index, key] of keys.entries()) {
      if (stored.has(key) || missing.has(key)) continue;
      const row = this.#read.get(key);
      if (row !== undefined && row.vector instanceof Uint8Array)
        stored.set(key, row.vector);
      else missing.set(key, params.values[index] ?? '');
    }
    const result =
      missing.size === 0
        ? { embeddings: [], usage: { tokens: 0 }, warnings: [] }
        : await this.#embedMissing(model, params, missing, stored);
    return {
      ...result,
      embeddings: keys.map((key) =>
        VectorCache.#unitFloat32(stored.get(key) ?? new Uint8Array()),
      ),
    };
  }

  async #embedMissing(
    model: Call['model'],
    params: Call['params'],
    missing: ReadonlyMap<string, string>,
    stored: Map<string, Uint8Array>,
  ) {
    const result = await model.doEmbed({
      ...params,
      values: [...missing.values()],
    });
    VectorCache.#check(result.embeddings, missing.size);
    const blobs = result.embeddings.map((vector) =>
      VectorCache.#float16(vector),
    );
    transaction(
      this.#database,
      () => {
        for (const [index, key] of [...missing.keys()].entries()) {
          const blob = blobs[index] ?? new Uint8Array();
          this.#write.run(key, blob);
          stored.set(key, blob);
        }
      },
      { mode: 'immediate' },
    );
    return result;
  }

  // Each row derives from a text and the model, so a stale table is replaced
  // with its rows: the next call embeds the texts again.
  static #declaration(): Declaration {
    VectorCache.#schema ??= new Declaration(
      [
        `CREATE TABLE vector_cache (
  -- sha256 of the provider and id of the model and the text that it embeds.
  key TEXT PRIMARY KEY,
  -- The unit vector as float16 values, little-endian, as Venn stores it.
  vector BLOB NOT NULL
) STRICT`,
      ],
      { rows: 'replace' },
    );
    return VectorCache.#schema;
  }

  static #check(embeddings: readonly (readonly number[])[], count: number) {
    if (embeddings.length !== count)
      throw new InvalidEmbeddingError(
        `${embeddings.length} vectors for ${count} texts`,
      );
    const width = embeddings[0]?.length;
    for (const vector of embeddings) {
      if (vector.length !== width)
        throw new InvalidEmbeddingError(
          `vectors of ${width} and of ${vector.length} numbers`,
        );
      if (!vector.every(Number.isFinite))
        throw new InvalidEmbeddingError('a value that is not finite');
    }
  }

  // The vector normalized in float64, then rounded to float16, as Venn
  // stores it (venn/server.py:275).
  static #float16(vector: readonly number[]): Uint8Array {
    const norm = Math.max(Math.hypot(...vector), NORM_EPSILON);
    const bytes = new Uint8Array(vector.length * FLOAT16_BYTES);
    const view = new DataView(bytes.buffer);
    for (const [index, value] of vector.entries())
      view.setFloat16(index * FLOAT16_BYTES, value / norm, true);
    return bytes;
  }

  // The float32 copy of the stored vector divided by its norm, as Venn's
  // embed gives it (venn/server.py:163).
  static #unitFloat32(bytes: Uint8Array): number[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const values = Array.from(
      { length: bytes.byteLength / FLOAT16_BYTES },
      (_, index) => view.getFloat16(index * FLOAT16_BYTES, true),
    );
    const norm = Math.max(Math.fround(Math.hypot(...values)), NORM_EPSILON);
    return values.map((value) => Math.fround(value / norm));
  }
}
