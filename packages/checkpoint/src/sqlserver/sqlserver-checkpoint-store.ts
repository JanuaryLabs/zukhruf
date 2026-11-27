import { hash } from 'node:crypto';

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
 * own driver. Parameters are named (`@p0` for the key `p0`). `transaction`
 * runs the work on one connection in one transaction, and gives the work a
 * session of that transaction.
 */
export type SqlServerSession = {
  query(
    sql: string,
    parameters: Readonly<Record<string, unknown>>,
    options?: SignalOption,
  ): Promise<readonly Record<string, unknown>[]>;
  transaction(
    work: (session: SqlServerSession) => Promise<void>,
  ): Promise<void>;
};

/** The write of a commit: it runs on the session of the commit's transaction. */
export type SqlServerWrite = (session: SqlServerSession) => Promise<void>;

const PAGE = 1000;

/**
 * Keeps checkpoints in two tables of a SQL Server schema (ADR 0011). A key of
 * SQL Server's index holds at most 900 bytes, so each row is keyed by the
 * SHA-256 of its names, as elt's checkpoint store keyed its copies.
 */
export class SqlServerCheckpointStore implements CheckpointStore<SqlServerWrite> {
  readonly #session: SqlServerSession;
  readonly #checkpoints: string;
  readonly #states: string;

  private constructor(session: SqlServerSession, schema: string) {
    this.#session = session;
    this.#checkpoints = `${identifier(schema)}.zukhruf_checkpoints`;
    this.#states = `${identifier(schema)}.zukhruf_checkpoint_states`;
  }

  /** Creates the tables when they are missing, and gives the store. */
  static async open(options: {
    readonly session: SqlServerSession;
    readonly schema?: string;
    readonly signal?: AbortSignal;
  }): Promise<SqlServerCheckpointStore> {
    const store = new SqlServerCheckpointStore(
      options.session,
      options.schema ?? 'dbo',
    );
    await options.session.transaction(async (session) => {
      await session.query(
        `DECLARE @locked int;
         EXEC @locked = sp_getapplock @Resource = N'zukhruf_checkpoint_tables', @LockMode = 'Exclusive', @LockOwner = 'Transaction';
         IF @locked < 0 THROW 51000, N'The tables of the checkpoint store could not be locked', 1;
         IF OBJECT_ID(N'${store.#checkpoints}', N'U') IS NULL
           CREATE TABLE ${store.#checkpoints} (id binary(32) NOT NULL PRIMARY KEY, consumer_group nvarchar(max) NOT NULL, stream nvarchar(max) NOT NULL, partition nvarchar(max) NOT NULL, group_id binary(32) NOT NULL, stream_id binary(32) NOT NULL, epoch bigint NOT NULL, checkpoint_id bigint NULL, version int NULL, position nvarchar(max) NULL);
         IF OBJECT_ID(N'${store.#states}', N'U') IS NULL
           CREATE TABLE ${store.#states} (id binary(32) NOT NULL, state_id binary(32) NOT NULL, key_id binary(32) NOT NULL, [key] nvarchar(max) NOT NULL, version int NOT NULL, value nvarchar(max) NOT NULL, PRIMARY KEY (id, state_id, key_id));`,
        {},
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
      `MERGE ${this.#checkpoints} WITH (HOLDLOCK) AS c
       USING (SELECT @id AS id) AS s ON c.id = s.id
       WHEN MATCHED THEN UPDATE SET epoch = c.epoch + 1
       WHEN NOT MATCHED THEN INSERT (id, consumer_group, stream, partition, group_id, stream_id, epoch)
         VALUES (@id, @consumerGroup, @stream, @partition, @groupId, @streamId, 1)
       OUTPUT inserted.epoch;`,
      {
        id: checkpointId(key),
        consumerGroup: key.consumerGroup,
        stream: key.stream,
        partition: key.partition,
        groupId: groupId(key.consumerGroup),
        streamId: streamId(key.consumerGroup, key.stream),
      },
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
       WHERE id = @id AND checkpoint_id IS NOT NULL`,
      { id: checkpointId(key) },
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
      `SELECT [key], version, value FROM ${this.#states}
       WHERE id = @id AND state_id = @stateId AND key_id IN (SELECT CONVERT(binary(32), value, 2) FROM OPENJSON(@keys))`,
      { id: checkpointId(key), stateId: digest(state), keys: hashes(keys) },
      signalOf(options),
    );
    return new Map(rows.map((row) => [named(key, row), value(key, row)]));
  }

  scan(
    key: CheckpointKey,
    state: string,
    options?: SignalOption,
  ): AsyncIterable<readonly [string, StoredValue]> {
    return this.#pages(key, state, Buffer.alloc(32), options);
  }

  /** The values of one map state in the order of their key hashes, page by page. */
  async *#pages(
    key: CheckpointKey,
    state: string,
    after: Buffer,
    options?: SignalOption,
  ): AsyncIterable<readonly [string, StoredValue]> {
    const rows = await this.#session.query(
      `SELECT TOP (${PAGE}) key_id, [key], version, value FROM ${this.#states}
       WHERE id = @id AND state_id = @stateId AND key_id > @after ORDER BY key_id`,
      { id: checkpointId(key), stateId: digest(state), after },
      signalOf(options),
    );
    for (const row of rows) yield [named(key, row), value(key, row)];
    const last = rows.at(-1)?.['key_id'];
    if (rows.length === PAGE && Buffer.isBuffer(last))
      yield* this.#pages(key, state, last, options);
  }

  async commit(
    key: CheckpointKey,
    epoch: FencingToken,
    checkpoint: StoredCheckpoint,
    changes: StateChanges,
    options?: SignalOption & { readonly write?: SqlServerWrite },
  ): Promise<void> {
    const id = checkpointId(key);
    const signal = signalOf(options);
    await this.#session.transaction(async (session) => {
      const [row] = await session.query(
        `SELECT epoch FROM ${this.#checkpoints} WITH (UPDLOCK, HOLDLOCK) WHERE id = @id`,
        { id },
        signal,
      );
      if (row === undefined || integer(key, row, 'epoch') !== epoch.value)
        throw new CheckpointFencedError(key, epoch);
      await options?.write?.(session);
      for (const state of changes.cleared)
        await session.query(
          `DELETE FROM ${this.#states} WHERE id = @id AND state_id = @stateId`,
          { id, stateId: digest(state) },
          signal,
        );
      for (const [state, keys] of changes.deleted)
        await session.query(
          `DELETE FROM ${this.#states}
           WHERE id = @id AND state_id = @stateId AND key_id IN (SELECT CONVERT(binary(32), value, 2) FROM OPENJSON(@keys))`,
          { id, stateId: digest(state), keys: hashes([...keys]) },
          signal,
        );
      for (const [state, values] of changes.set)
        await session.query(
          `MERGE ${this.#states} WITH (HOLDLOCK) AS s
           USING (SELECT CONVERT(binary(32), key_id, 2) AS key_id, [key], version, value
                  FROM OPENJSON(@rows) WITH (key_id char(64), [key] nvarchar(max), version int, value nvarchar(max))) AS r
           ON s.id = @id AND s.state_id = @stateId AND s.key_id = r.key_id
           WHEN MATCHED THEN UPDATE SET version = r.version, value = r.value
           WHEN NOT MATCHED THEN INSERT (id, state_id, key_id, [key], version, value)
             VALUES (@id, @stateId, r.key_id, r.[key], r.version, r.value);`,
          {
            id,
            stateId: digest(state),
            rows: JSON.stringify(
              [...values].map(([name, entry]) => ({
                key_id: digest(name).toHex(),
                key: JSON.stringify(name),
                version: entry.version,
                value: JSON.stringify(entry.json),
              })),
            ),
          },
          signal,
        );
      await session.query(
        `UPDATE ${this.#checkpoints} SET checkpoint_id = @checkpointId, version = @version, position = @position WHERE id = @id`,
        {
          id,
          checkpointId: checkpoint.checkpointId,
          version: checkpoint.version,
          position: JSON.stringify(checkpoint.json),
        },
        signal,
      );
    });
  }

  async *list(
    consumerGroup: string,
    options?: SignalOption & { readonly stream?: string },
  ): AsyncIterable<CheckpointSummary> {
    const rows = await this.#session.query(
      `SELECT stream, partition, checkpoint_id, epoch FROM ${this.#checkpoints}
       WHERE group_id = @groupId AND (@streamId IS NULL OR stream_id = @streamId) AND checkpoint_id IS NOT NULL`,
      {
        groupId: groupId(consumerGroup),
        streamId:
          options?.stream === undefined
            ? null
            : streamId(consumerGroup, options.stream),
      },
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
    const parameters = {
      streamId: streamId(consumerGroup, target.stream),
      id:
        target.partition === undefined
          ? null
          : checkpointId({
              consumerGroup,
              ...target,
              partition: target.partition,
            }),
    };
    await this.#session.transaction(async (session) => {
      await session.query(
        `UPDATE ${this.#checkpoints} SET epoch = epoch + 1, checkpoint_id = NULL, version = NULL, position = NULL
         WHERE stream_id = @streamId AND (@id IS NULL OR id = @id);
         DELETE s FROM ${this.#states} AS s JOIN ${this.#checkpoints} AS c ON c.id = s.id
         WHERE c.stream_id = @streamId AND (@id IS NULL OR c.id = @id);`,
        parameters,
        signalOf(options),
      );
    });
  }
}

function identifier(name: string): string {
  return `[${name.replaceAll(']', ']]')}]`;
}

/** The key hashes of `names` as a JSON array of hex text, for OPENJSON. */
function hashes(names: readonly string[]): string {
  return JSON.stringify(names.map((name) => digest(name).toHex()));
}

function sha256OfJson(value: unknown): Buffer {
  return hash('sha256', JSON.stringify(value), 'buffer');
}

function digest(name: string): Buffer {
  return sha256OfJson(name);
}

function checkpointId(key: CheckpointKey): Buffer {
  return sha256OfJson([key.consumerGroup, key.stream, key.partition]);
}

function groupId(consumerGroup: string): Buffer {
  return sha256OfJson([consumerGroup]);
}

function streamId(consumerGroup: string, stream: string): Buffer {
  return sha256OfJson([consumerGroup, stream]);
}

function signalOf(options?: SignalOption): SignalOption {
  return options?.signal === undefined ? {} : { signal: options.signal };
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

function json(
  key: CheckpointKey,
  row: Record<string, unknown>,
  column: string,
): Json {
  const source = row[column];
  if (typeof source !== 'string')
    throw new CorruptCheckpointError(key, `${column} is not text`);
  try {
    return toJson(JSON.parse(source));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new CorruptCheckpointError(key, `${column} is not JSON`);
    throw error;
  }
}

function named(key: CheckpointKey, row: Record<string, unknown>): string {
  const name = json(key, row, 'key');
  if (typeof name === 'string') return name;
  throw new CorruptCheckpointError(key, 'key is not a JSON string');
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
