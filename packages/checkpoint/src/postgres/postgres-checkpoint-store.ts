import { FencingToken } from '@zukhruf/fencing';

import type { CheckpointStore } from '../checkpoint-store.ts';
import type {
  CheckpointKey,
  CheckpointSummary,
  Json,
  SignalOption,
  StateChanges,
  StoredCheckpoint,
  StoredValue,
} from '../checkpoint.ts';
import { CheckpointFencedError, CorruptCheckpointError } from '../errors.ts';

/**
 * The port through which the store sends its SQL; the host writes it over its
 * own driver. Parameters are positional (`$1`). `transaction` runs the work on
 * one connection in one transaction, and gives the work a session of that
 * transaction.
 */
export type PostgresSession = {
  query(
    sql: string,
    parameters: readonly unknown[],
    options?: SignalOption,
  ): Promise<readonly Record<string, unknown>[]>;
  transaction(work: (session: PostgresSession) => Promise<void>): Promise<void>;
};

/** The write of a commit: it runs on the session of the commit's transaction. */
export type PostgresWrite = (session: PostgresSession) => Promise<void>;

const PAGE = 1000;

/**
 * Keeps checkpoints in two tables of a Postgres schema (ADR 0011). A
 * destination in the same database commits its output with the checkpoint,
 * in the `write` of the commit.
 */
export class PostgresCheckpointStore implements CheckpointStore<PostgresWrite> {
  readonly #session: PostgresSession;
  readonly #checkpoints: string;
  readonly #states: string;

  private constructor(session: PostgresSession, schema: string) {
    this.#session = session;
    this.#checkpoints = `${identifier(schema)}.zukhruf_checkpoints`;
    this.#states = `${identifier(schema)}.zukhruf_checkpoint_states`;
  }

  /** Creates the tables when they are missing, and gives the store. */
  static async open(options: {
    readonly session: PostgresSession;
    readonly schema?: string;
    readonly signal?: AbortSignal;
  }): Promise<PostgresCheckpointStore> {
    const store = new PostgresCheckpointStore(
      options.session,
      options.schema ?? 'public',
    );
    await options.session.transaction(async (session) => {
      await session.query(
        `SELECT pg_advisory_xact_lock(hashtext('zukhruf_checkpoint_tables'))`,
        [],
        signalOf(options),
      );
      await session.query(
        `CREATE TABLE IF NOT EXISTS ${store.#checkpoints} (consumer_group text NOT NULL, stream text NOT NULL, partition text NOT NULL, epoch bigint NOT NULL, checkpoint_id bigint, version integer, position text, PRIMARY KEY (consumer_group, stream, partition))`,
        [],
        signalOf(options),
      );
      await session.query(
        `CREATE TABLE IF NOT EXISTS ${store.#states} (consumer_group text NOT NULL, stream text NOT NULL, partition text NOT NULL, state text NOT NULL, key text NOT NULL, version integer NOT NULL, value text NOT NULL, PRIMARY KEY (consumer_group, stream, partition, state, key))`,
        [],
        signalOf(options),
      );
    });
    return store;
  }

  async claim(
    key: CheckpointKey,
    options?: SignalOption,
  ): Promise<FencingToken> {
    const [row] = await this.#session.query(
      `INSERT INTO ${this.#checkpoints} AS c (consumer_group, stream, partition, epoch) VALUES ($1, $2, $3, 1)
       ON CONFLICT (consumer_group, stream, partition) DO UPDATE SET epoch = c.epoch + 1 RETURNING epoch`,
      [key.consumerGroup, key.stream, key.partition],
      signalOf(options),
    );
    return new FencingToken(integer(key, row, 'epoch'));
  }

  async read(
    key: CheckpointKey,
    options?: SignalOption,
  ): Promise<StoredCheckpoint | undefined> {
    const [row] = await this.#session.query(
      `SELECT checkpoint_id, version, position FROM ${this.#checkpoints}
       WHERE consumer_group = $1 AND stream = $2 AND partition = $3 AND checkpoint_id IS NOT NULL`,
      [key.consumerGroup, key.stream, key.partition],
      signalOf(options),
    );
    if (row === undefined) return undefined;
    return {
      checkpointId: Number(integer(key, row, 'checkpoint_id')),
      version: Number(integer(key, row, 'version')),
      json: json(key, row, 'position'),
    };
  }

  async get(
    key: CheckpointKey,
    state: string,
    keys: readonly string[],
    options?: SignalOption,
  ): Promise<ReadonlyMap<string, StoredValue>> {
    const rows = await this.#session.query(
      `SELECT key, version, value FROM ${this.#states}
       WHERE consumer_group = $1 AND stream = $2 AND partition = $3 AND state = $4 AND key = ANY($5::text[])`,
      [key.consumerGroup, key.stream, key.partition, state, keys.map(stored)],
      signalOf(options),
    );
    return new Map(rows.map((row) => [named(key, row), value(key, row)]));
  }

  scan(
    key: CheckpointKey,
    state: string,
    options?: SignalOption,
  ): AsyncIterable<readonly [string, StoredValue]> {
    return this.#pages(key, state, null, options);
  }

  /** The values of one map state in key order, one page after another. */
  async *#pages(
    key: CheckpointKey,
    state: string,
    after: string | null,
    options?: SignalOption,
  ): AsyncIterable<readonly [string, StoredValue]> {
    const rows = await this.#session.query(
      `SELECT key, version, value FROM ${this.#states}
       WHERE consumer_group = $1 AND stream = $2 AND partition = $3 AND state = $4 AND ($5::text IS NULL OR key > $5)
       ORDER BY key LIMIT ${PAGE}`,
      [key.consumerGroup, key.stream, key.partition, state, after],
      signalOf(options),
    );
    for (const row of rows) yield [named(key, row), value(key, row)];
    const last = rows.at(-1);
    if (rows.length === PAGE && last !== undefined)
      yield* this.#pages(key, state, text(key, last, 'key'), options);
  }

  async commit(
    key: CheckpointKey,
    epoch: FencingToken,
    checkpoint: StoredCheckpoint,
    changes: StateChanges,
    options?: SignalOption & { readonly write?: PostgresWrite },
  ): Promise<void> {
    const where = [key.consumerGroup, key.stream, key.partition];
    await this.#session.transaction(async (session) => {
      const [row] = await session.query(
        `SELECT epoch FROM ${this.#checkpoints} WHERE consumer_group = $1 AND stream = $2 AND partition = $3 FOR UPDATE`,
        where,
        signalOf(options),
      );
      if (row === undefined || integer(key, row, 'epoch') !== epoch.value)
        throw new CheckpointFencedError(key, epoch);
      await options?.write?.(session);
      if (changes.cleared.size > 0)
        await session.query(
          `DELETE FROM ${this.#states} WHERE consumer_group = $1 AND stream = $2 AND partition = $3 AND state = ANY($4::text[])`,
          [...where, [...changes.cleared]],
          signalOf(options),
        );
      for (const [state, keys] of changes.deleted)
        await session.query(
          `DELETE FROM ${this.#states} WHERE consumer_group = $1 AND stream = $2 AND partition = $3 AND state = $4 AND key = ANY($5::text[])`,
          [...where, state, [...keys].map(stored)],
          signalOf(options),
        );
      for (const [state, values] of changes.set) {
        const entries = [...values];
        await session.query(
          `INSERT INTO ${this.#states} (consumer_group, stream, partition, state, key, version, value)
           SELECT $1, $2, $3, $4, k, v, j FROM unnest($5::text[], $6::integer[], $7::text[]) AS t(k, v, j)
           ON CONFLICT (consumer_group, stream, partition, state, key) DO UPDATE SET version = excluded.version, value = excluded.value`,
          [
            ...where,
            state,
            entries.map(([name]) => stored(name)),
            entries.map(([, stored]) => stored.version),
            entries.map(([, stored]) => JSON.stringify(stored.json)),
          ],
          signalOf(options),
        );
      }
      await session.query(
        `UPDATE ${this.#checkpoints} SET checkpoint_id = $4, version = $5, position = $6
         WHERE consumer_group = $1 AND stream = $2 AND partition = $3`,
        [
          ...where,
          checkpoint.checkpointId,
          checkpoint.version,
          JSON.stringify(checkpoint.json),
        ],
        signalOf(options),
      );
    });
  }

  async *list(
    consumerGroup: string,
    options?: SignalOption & { readonly stream?: string },
  ): AsyncIterable<CheckpointSummary> {
    const rows = await this.#session.query(
      `SELECT stream, partition, checkpoint_id, epoch FROM ${this.#checkpoints}
       WHERE consumer_group = $1 AND ($2::text IS NULL OR stream = $2) AND checkpoint_id IS NOT NULL
       ORDER BY stream, partition`,
      [consumerGroup, options?.stream ?? null],
      signalOf(options),
    );
    for (const row of rows) {
      const key = {
        consumerGroup,
        stream: String(row['stream']),
        partition: String(row['partition']),
      };
      yield {
        stream: key.stream,
        partition: key.partition,
        checkpointId: Number(integer(key, row, 'checkpoint_id')),
        epoch: new FencingToken(integer(key, row, 'epoch')),
      };
    }
  }

  async reset(
    consumerGroup: string,
    target: { readonly stream: string; readonly partition?: string },
    options?: SignalOption,
  ): Promise<void> {
    const partition = target.partition ?? null;
    await this.#session.transaction(async (session) => {
      await session.query(
        `UPDATE ${this.#checkpoints} SET epoch = epoch + 1, checkpoint_id = NULL, version = NULL, position = NULL
         WHERE consumer_group = $1 AND stream = $2 AND ($3::text IS NULL OR partition = $3)`,
        [consumerGroup, target.stream, partition],
        signalOf(options),
      );
      await session.query(
        `DELETE FROM ${this.#states}
         WHERE consumer_group = $1 AND stream = $2 AND ($3::text IS NULL OR partition = $3)`,
        [consumerGroup, target.stream, partition],
        signalOf(options),
      );
    });
  }
}

function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function integer(
  key: CheckpointKey,
  row: Record<string, unknown> | undefined,
  column: string,
): bigint {
  const cell = row?.[column];
  if (typeof cell === 'number' && Number.isInteger(cell)) return BigInt(cell);
  if (typeof cell === 'bigint') return cell;
  if (typeof cell === 'string' && /^-?\d+$/.test(cell)) return BigInt(cell);
  throw new CorruptCheckpointError(key, `${column} is not an integer`);
}

function text(
  key: CheckpointKey,
  row: Record<string, unknown>,
  column: string,
): string {
  const cell = row[column];
  if (typeof cell === 'string') return cell;
  throw new CorruptCheckpointError(key, `${column} is not text`);
}

function json(
  key: CheckpointKey,
  row: Record<string, unknown>,
  column: string,
): Json {
  const source = text(key, row, column);
  try {
    return toJson(JSON.parse(source));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new CorruptCheckpointError(key, `${column} is not JSON`);
    throw error;
  }
}

function value(key: CheckpointKey, row: Record<string, unknown>): StoredValue {
  return {
    version: Number(integer(key, row, 'version')),
    json: json(key, row, 'value'),
  };
}

/** JSON.parse gives only JSON values; this gives them their type. */
function toJson(parsed: unknown): Json {
  if (
    parsed === null ||
    typeof parsed === 'boolean' ||
    typeof parsed === 'number' ||
    typeof parsed === 'string'
  )
    return parsed;
  if (Array.isArray(parsed)) return parsed.map(toJson);
  if (typeof parsed === 'object')
    return Object.fromEntries(
      Object.entries(parsed).map(([name, item]) => [name, toJson(item)]),
    );
  throw new TypeError(`JSON.parse gave ${typeof parsed}`);
}

/** The signal of a call, without its other options, for the host's query. */
function signalOf(options?: SignalOption): SignalOption {
  return options?.signal === undefined ? {} : { signal: options.signal };
}

/**
 * A map state key as the key column keeps it: JSON text. Postgres text refuses
 * a NUL byte, and UTF-8 would replace a lone surrogate, so a raw key would not
 * come back as it went in.
 */
function stored(name: string): string {
  return JSON.stringify(name);
}

function named(key: CheckpointKey, row: Record<string, unknown>): string {
  const name = json(key, row, 'key');
  if (typeof name === 'string') return name;
  throw new CorruptCheckpointError(key, 'key is not a JSON string');
}
