import { randomUUID } from 'node:crypto';

import { type Clock, delay, timeout, untilAborted } from '@zukhruf/async';
import { FencingToken } from '@zukhruf/fencing';
import { LeaseController } from '@zukhruf/lease';

import type { LockHandle } from '../../mutex/lease.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';
import { InProcessTurns } from '../../shared/in-process-turns.ts';
import { keyDigest } from '../../shared/key-digest.ts';

/**
 * One connection to SQL Server: only the methods that the store calls. No
 * driver object fits it as it is; a `Connection` of tedious fits it through a
 * small wrapper.
 */
export interface SqlServerSession {
  /** Runs one batch. Each parameter is an `nvarchar`. Resolves to the rows of the batch. */
  query(
    text: string,
    parameters: Record<string, string>,
  ): Promise<Record<string, unknown>[]>;
  on(event: 'error', listener: (error: Error) => void): unknown;
  /** Ends the session: closes the connection, or gives it back to its pool. */
  close(): void;
}

export interface SqlServerStoreOptions {
  /**
   * Gives a session that is connected. The store runs one batch on it, and
   * then closes it. A holder's lease counts from the moment the store has the
   * session, so a session that connects in its first query spends that
   * connect from the lease (#5973).
   */
  connect(): Promise<SqlServerSession>;
  /** The name of an existing table for the leases. The store runs no DDL. */
  table: string;
  /** The name of an existing sequence for the fencing tokens. The store runs no DDL. */
  sequence: string;
  /**
   * Milliseconds between two renewals of a holder, and between two tries of
   * a waiter. A holder whose renewals fail for two intervals stops: its
   * signal aborts.
   */
  heartbeatInterval: number;
  /**
   * Milliseconds after its last renewal, on the server's clock, at which the
   * lease of a holder ends and another store can take the key. It must be
   * larger than two heartbeat intervals, so a holder stops before another
   * store can take its key. Default: 30,000.
   */
  leaseDuration?: number;
  /** The clock of the heartbeat and of the tries: `globalThis` in production, a fake clock in a test. */
  clock: Clock;
}

/**
 * Runs `@statement` with the parameters `names` on the lease table and the
 * token sequence. The name of an object cannot be a parameter, so the batch
 * finds each object by name, as `regclass` does, puts its quoted name in
 * place of `{table}` or `{sequence}`, and runs the statement with
 * `sp_executesql`.
 */
const onObjects = (names: readonly string[]) =>
  `DECLARE @tableId int = OBJECT_ID(@table, 'U'), @sequenceId int = OBJECT_ID(@sequence, 'SO'), @message nvarchar(2048);
IF @tableId IS NULL
BEGIN
  SET @message = N'The table ' + @table + N' does not exist, or the role has no permission on it.';
  THROW 50000, @message, 1;
END;
IF @sequenceId IS NULL
BEGIN
  SET @message = N'The sequence ' + @sequence + N' does not exist, or the role has no permission on it.';
  THROW 50000, @message, 1;
END;
DECLARE @text nvarchar(max) = REPLACE(REPLACE(@statement,
  N'{table}', QUOTENAME(OBJECT_SCHEMA_NAME(@tableId)) + N'.' + QUOTENAME(OBJECT_NAME(@tableId))),
  N'{sequence}', QUOTENAME(OBJECT_SCHEMA_NAME(@sequenceId)) + N'.' + QUOTENAME(OBJECT_NAME(@sequenceId)));
EXEC sp_executesql @text, N'${names.map((name) => `@${name} nvarchar(max)`).join(', ')}', ${names.map((name) => `@${name}`).join(', ')};`;

/**
 * A compare and set: the store takes the key when its row is free or its
 * lease ended on the server's clock, or adds the row of a key that has none.
 * Of two stores that add one row, the second gets a duplicate key and no
 * grant. The token comes from the sequence in the same statement.
 */
const grantStatement = `DECLARE @granted TABLE (token bigint);
UPDATE {table}
SET holder = CAST(@holder AS uniqueidentifier), token = NEXT VALUE FOR {sequence}, renewed = SYSUTCDATETIME(), duration = CAST(@duration AS int)
OUTPUT inserted.token INTO @granted
WHERE name = CONVERT(binary(16), @name, 2)
  AND (holder IS NULL OR DATEADD(millisecond, duration, renewed) <= SYSUTCDATETIME());
IF @@ROWCOUNT = 0 AND NOT EXISTS (SELECT 1 FROM {table} WHERE name = CONVERT(binary(16), @name, 2))
BEGIN
  BEGIN TRY
    INSERT INTO {table} (name, holder, token, renewed, duration)
    OUTPUT inserted.token INTO @granted
    VALUES (CONVERT(binary(16), @name, 2), CAST(@holder AS uniqueidentifier), NEXT VALUE FOR {sequence}, SYSUTCDATETIME(), CAST(@duration AS int));
  END TRY
  BEGIN CATCH
    IF ERROR_NUMBER() NOT IN (2601, 2627) THROW;
  END CATCH;
END;
SELECT CAST(token AS nvarchar(20)) AS token FROM @granted;`;

const renewStatement = `UPDATE {table} SET renewed = SYSUTCDATETIME()
WHERE name = CONVERT(binary(16), @name, 2) AND holder = CAST(@holder AS uniqueidentifier);
SELECT @@ROWCOUNT AS count;`;

const releaseStatement = `UPDATE {table} SET holder = NULL
WHERE name = CONVERT(binary(16), @name, 2) AND holder = CAST(@holder AS uniqueidentifier);
SELECT @@ROWCOUNT AS count;`;

const heldStatement = `SELECT CASE WHEN EXISTS (
  SELECT 1 FROM {table}
  WHERE name = CONVERT(binary(16), @name, 2)
    AND holder IS NOT NULL
    AND DATEADD(millisecond, duration, renewed) > SYSUTCDATETIME()
) THEN 1 ELSE 0 END AS held;`;

/** Runs one statement; `sent` runs once the session is there, right before the statement goes to the server. */
type Run = (
  statement: string,
  parameters: Record<string, string>,
  sent?: () => void,
) => Promise<Record<string, unknown>[]>;

/**
 * Keeps a lease row in a table of SQL Server for each key. The holder renews
 * its row each `heartbeatInterval`, and another store takes the key when the
 * lease ended on the server's clock, `leaseDuration` after its last renewal.
 * Thus a holder that vanished loses its key also when the server never sees
 * its session end. Every process on every machine that reaches one database
 * shares the keys.
 *
 * Callers in this process first line up in a queue in memory, so only the
 * first one tries the key: one try per key per process, however many callers
 * wait, and first-come order within the process.
 */
export class SqlServerStore implements LockStore {
  readonly #turns = new InProcessTurns();
  readonly #options: SqlServerStoreOptions;
  readonly #leaseDuration: number;

  constructor(options: SqlServerStoreOptions) {
    const { heartbeatInterval, leaseDuration = 30_000 } = options;
    if (!(leaseDuration > 2 * heartbeatInterval)) {
      throw new RangeError(
        `leaseDuration (${leaseDuration} ms) must be larger than two heartbeat intervals (${2 * heartbeatInterval} ms), so a holder stops before another store can take its key.`,
      );
    }
    this.#options = options;
    this.#leaseDuration = leaseDuration;
  }

  acquire(key: string, options?: AcquireOptions): Promise<LockHandle> {
    return this.#turns.acquire(key, options, async () => {
      const signal = options?.signal;
      const { clock, heartbeatInterval } = this.#options;
      for (;;) {
        const handle = await this.#try(key, signal);
        if (handle) return handle;
        await delay(heartbeatInterval, { clock, signal });
      }
    });
  }

  tryAcquire(key: string): Promise<LockHandle | undefined> {
    return this.#turns.tryAcquire(key, () => this.#try(key, undefined));
  }

  /** Reads the row of `key`, and never takes the key. */
  async isHeld(key: string): Promise<boolean> {
    const [row] = await this.#run(heldStatement, { name: leaseName(key) });
    return row?.held === 1;
  }

  /** Tries the key once. A cancel rejects at once, and a grant that comes after the cancel is released. */
  async #try(
    key: string,
    signal: AbortSignal | undefined,
  ): Promise<LockHandle | undefined> {
    signal?.throwIfAborted();
    const lease = new KeyLease(key, this.#run, this.#options);
    const granting = lease.grant(this.#leaseDuration);
    let token: FencingToken | undefined;
    try {
      token = await untilAborted(granting, signal);
    } catch (error) {
      if (signal?.aborted && error === signal.reason) {
        void granting.then(
          (late) => (late ? lease.release() : undefined),
          () => {},
        );
      }
      throw error;
    }
    return token && lease.hold(token);
  }

  /** Runs one statement on a session of its own. */
  readonly #run: Run = async (statement, parameters, sent) => {
    const session = await this.#options.connect();
    // A driver can emit `error` after the close, and an `error` with no listener stops the process.
    session.on('error', () => {});
    try {
      sent?.();
      return await session.query(onObjects(Object.keys(parameters)), {
        ...parameters,
        statement,
        table: this.#options.table,
        sequence: this.#options.sequence,
      });
    } finally {
      session.close();
    }
  };
}

/**
 * The name of the lease row of `key`: the first 16 bytes of the key digest,
 * as 32 hex characters. The batch converts them to the `binary(16)` of the
 * row.
 */
export function leaseName(key: string): string {
  return keyDigest(key).subarray(0, 16).toHex();
}

/** One grant of one key: its row, its holder ID, and its heartbeat. */
class KeyLease {
  readonly #key: string;
  readonly #run: Run;
  readonly #heartbeatInterval: number;
  readonly #clock: Clock;
  readonly #row: { name: string; holder: string };
  readonly #lease: LeaseController;
  /** When the grant statement went to the server, on the clock. */
  #granted = 0;
  /** Aborts when the store stops holding: a release, or a lost lease. */
  readonly #done = new AbortController();

  constructor(
    key: string,
    run: Run,
    { heartbeatInterval, clock }: SqlServerStoreOptions,
  ) {
    this.#key = key;
    this.#run = run;
    this.#heartbeatInterval = heartbeatInterval;
    this.#clock = clock;
    this.#row = { name: leaseName(key), holder: randomUUID() };
    this.#lease = new LeaseController(key);
  }

  /** The token of a grant, or `undefined` when another holder has the key. */
  async grant(leaseDuration: number): Promise<FencingToken | undefined> {
    const [row] = await this.#run(
      grantStatement,
      { ...this.#row, duration: String(leaseDuration) },
      () => (this.#granted = this.#clock.performance.now()),
    );
    if (row === undefined) return undefined;
    if (typeof row.token !== 'string') {
      throw new Error(
        `The grant of ${JSON.stringify(this.#key)} gave no token.`,
      );
    }
    return new FencingToken(BigInt(row.token));
  }

  /**
   * Starts the heartbeat, counted from when the grant statement went to the
   * server: the server starts the lease when it runs the statement, which is
   * later, so the holder still stops before the lease can end. A count from
   * before the session came lost the lease at the first renewal when the
   * connect took longer than two intervals (#5973).
   */
  hold(token: FencingToken): LockHandle {
    void this.#beat(this.#granted);
    return {
      token,
      signal: this.#lease.signal,
      [Symbol.asyncDispose]: () => this.release(),
    };
  }

  /**
   * Renews the row each interval. A renewal that touches no row means that
   * another store took the key. The holder also stops when no renewal
   * succeeded for two intervals, counted from when the statement of the last
   * renewal that succeeded went to the server: the server counts the lease
   * from a time after that, so the holder stops before the lease can end.
   */
  async #beat(started: number): Promise<void> {
    const interval = this.#heartbeatInterval;
    const clock = this.#clock;
    const done = this.#done.signal;
    let renewed = started;
    try {
      for (;;) {
        await delay(Math.max(renewed + interval - clock.performance.now(), 0), {
          clock,
          signal: done,
        });
        const start = clock.performance.now();
        using limit = timeout(renewed + 2 * interval - start, { clock });
        let sent = start;
        const [row] = await untilAborted(
          this.#run(renewStatement, this.#row, () => {
            sent = clock.performance.now();
          }),
          AbortSignal.any([done, limit.signal]),
        );
        if (row?.count !== 1) {
          throw new Error(
            `Another store took the key ${JSON.stringify(this.#key)}.`,
          );
        }
        renewed = sent;
      }
    } catch (cause) {
      if (!done.aborted) this.#lose(cause);
    }
  }

  /** Another holder can have the key now: at once, or when the lease ends on the server's clock. */
  #lose(cause: unknown): void {
    this.#done.abort();
    this.#lease.lose(cause);
  }

  async release(): Promise<void> {
    if (this.#done.signal.aborted) return;
    this.#done.abort();
    try {
      const [row] = await this.#run(releaseStatement, this.#row);
      if (row?.count !== 1) {
        throw new Error(
          `Another store took the key ${JSON.stringify(this.#key)} before the release.`,
        );
      }
    } catch (cause) {
      this.#lease.lose(cause);
      return;
    }
    this.#lease.end();
  }
}
