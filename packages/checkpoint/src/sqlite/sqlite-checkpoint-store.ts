import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import { FencingToken } from '@zukhruf/fencing';
import { Declaration } from '@zukhruf/sqlite-drift';
import { transaction } from '@zukhruf/sqlite-transaction';

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
 * The write of a commit: it runs on the database, in the commit's transaction.
 * It returns undefined, so an async function does not compile: its awaited
 * part would run after the transaction.
 */
export type SqliteWrite = (database: DatabaseSync) => undefined;

type Row = Record<string, SQLOutputValue>;

// Rows 'keep': a newer version of the package keeps the saved checkpoints.
const tables = new Declaration(
  [
    `CREATE TABLE zukhruf_checkpoints (consumer_group TEXT NOT NULL, stream TEXT NOT NULL, partition TEXT NOT NULL, epoch INTEGER NOT NULL, checkpoint_id INTEGER, version INTEGER, position TEXT, PRIMARY KEY (consumer_group, stream, partition)) STRICT`,
    `CREATE TABLE zukhruf_checkpoint_states (consumer_group TEXT NOT NULL, stream TEXT NOT NULL, partition TEXT NOT NULL, state TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (consumer_group, stream, partition, state, key)) STRICT, WITHOUT ROWID`,
  ],
  { rows: 'keep' },
);

/**
 * Keeps checkpoints in two tables of a SQLite database that the host opens
 * (ADR 0011). A destination in the same database commits its output with the
 * checkpoint, in the `write` of the commit.
 */
export class SqliteCheckpointStore implements CheckpointStore<SqliteWrite> {
  readonly #database: DatabaseSync;

  constructor(options: { readonly database: DatabaseSync }) {
    this.#database = options.database;
    tables.apply(this.#database);
  }

  async claim(
    key: CheckpointKey,
    options?: SignalOption,
  ): Promise<FencingToken> {
    options?.signal?.throwIfAborted();
    const row = this.#database
      .prepare(
        `INSERT INTO zukhruf_checkpoints (consumer_group, stream, partition, epoch) VALUES (?, ?, ?, 1)
         ON CONFLICT DO UPDATE SET epoch = epoch + 1 RETURNING epoch`,
      )
      .get(key.consumerGroup, key.stream, key.partition);
    return new FencingToken(integer(key, row, 'epoch'));
  }

  async read(
    key: CheckpointKey,
    options?: SignalOption,
  ): Promise<StoredCheckpoint | undefined> {
    options?.signal?.throwIfAborted();
    const row = this.#database
      .prepare(
        `SELECT checkpoint_id, version, position FROM zukhruf_checkpoints
         WHERE consumer_group = ? AND stream = ? AND partition = ? AND checkpoint_id IS NOT NULL`,
      )
      .get(key.consumerGroup, key.stream, key.partition);
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
    options?.signal?.throwIfAborted();
    const select = this.#database.prepare(
      `SELECT version, value FROM zukhruf_checkpoint_states
       WHERE consumer_group = ? AND stream = ? AND partition = ? AND state = ? AND key = ?`,
    );
    const found = new Map<string, StoredValue>();
    for (const name of keys) {
      const row = select.get(
        key.consumerGroup,
        key.stream,
        key.partition,
        state,
        name,
      );
      if (row !== undefined) found.set(name, value(key, row));
    }
    return found;
  }

  async *scan(
    key: CheckpointKey,
    state: string,
    options?: SignalOption,
  ): AsyncIterable<readonly [string, StoredValue]> {
    options?.signal?.throwIfAborted();
    const rows = this.#database
      .prepare(
        `SELECT key, version, value FROM zukhruf_checkpoint_states
         WHERE consumer_group = ? AND stream = ? AND partition = ? AND state = ? ORDER BY key`,
      )
      .iterate(key.consumerGroup, key.stream, key.partition, state);
    for (const row of rows) yield [text(key, row, 'key'), value(key, row)];
  }

  async commit(
    key: CheckpointKey,
    epoch: FencingToken,
    checkpoint: StoredCheckpoint,
    changes: StateChanges,
    options?: SignalOption & { readonly write?: SqliteWrite },
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    const database = this.#database;
    const where = [key.consumerGroup, key.stream, key.partition] as const;
    transaction(
      database,
      () => {
        const row = database
          .prepare(
            `SELECT epoch FROM zukhruf_checkpoints WHERE consumer_group = ? AND stream = ? AND partition = ?`,
          )
          .get(...where);
        if (row === undefined || integer(key, row, 'epoch') !== epoch.value)
          throw new CheckpointFencedError(key, epoch);
        const written: unknown = options?.write?.(database);
        if (written instanceof Promise)
          throw new TypeError(
            'A write of the SQLite store runs in its transaction, so it cannot return a promise',
          );
        const clear = database.prepare(
          `DELETE FROM zukhruf_checkpoint_states WHERE consumer_group = ? AND stream = ? AND partition = ? AND state = ?`,
        );
        for (const state of changes.cleared) clear.run(...where, state);
        const remove = database.prepare(
          `DELETE FROM zukhruf_checkpoint_states WHERE consumer_group = ? AND stream = ? AND partition = ? AND state = ? AND key = ?`,
        );
        for (const [state, keys] of changes.deleted)
          for (const removed of keys) remove.run(...where, state, removed);
        const put = database.prepare(
          `INSERT INTO zukhruf_checkpoint_states (consumer_group, stream, partition, state, key, version, value) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO UPDATE SET version = excluded.version, value = excluded.value`,
        );
        for (const [state, values] of changes.set)
          for (const [name, stored] of values)
            put.run(
              ...where,
              state,
              name,
              stored.version,
              JSON.stringify(stored.json),
            );
        database
          .prepare(
            `UPDATE zukhruf_checkpoints SET checkpoint_id = ?, version = ?, position = ?
             WHERE consumer_group = ? AND stream = ? AND partition = ?`,
          )
          .run(
            checkpoint.checkpointId,
            checkpoint.version,
            JSON.stringify(checkpoint.json),
            ...where,
          );
      },
      { mode: 'immediate' },
    );
  }

  async *list(
    consumerGroup: string,
    options?: SignalOption & { readonly stream?: string },
  ): AsyncIterable<CheckpointSummary> {
    options?.signal?.throwIfAborted();
    const rows = this.#database
      .prepare(
        `SELECT stream, partition, checkpoint_id, epoch FROM zukhruf_checkpoints
         WHERE consumer_group = ? AND (? IS NULL OR stream = ?) AND checkpoint_id IS NOT NULL
         ORDER BY stream, partition`,
      )
      .iterate(consumerGroup, options?.stream ?? null, options?.stream ?? null);
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
    options?.signal?.throwIfAborted();
    const database = this.#database;
    const partition = target.partition ?? null;
    transaction(
      database,
      () => {
        database
          .prepare(
            `UPDATE zukhruf_checkpoints SET epoch = epoch + 1, checkpoint_id = NULL, version = NULL, position = NULL
             WHERE consumer_group = ? AND stream = ? AND (? IS NULL OR partition = ?)`,
          )
          .run(consumerGroup, target.stream, partition, partition);
        database
          .prepare(
            `DELETE FROM zukhruf_checkpoint_states
             WHERE consumer_group = ? AND stream = ? AND (? IS NULL OR partition = ?)`,
          )
          .run(consumerGroup, target.stream, partition, partition);
      },
      { mode: 'immediate' },
    );
  }
}

function integer(
  key: CheckpointKey,
  row: Row | undefined,
  column: string,
): bigint {
  const cell = row?.[column];
  if (typeof cell === 'number' && Number.isInteger(cell)) return BigInt(cell);
  if (typeof cell === 'bigint') return cell;
  throw new CorruptCheckpointError(key, `${column} is not an integer`);
}

function text(key: CheckpointKey, row: Row, column: string): string {
  const cell = row[column];
  if (typeof cell === 'string') return cell;
  throw new CorruptCheckpointError(key, `${column} is not text`);
}

function json(key: CheckpointKey, row: Row, column: string): Json {
  const source = text(key, row, column);
  try {
    return toJson(JSON.parse(source));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new CorruptCheckpointError(key, `${column} is not JSON`);
    throw error;
  }
}

function value(key: CheckpointKey, row: Row): StoredValue {
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
