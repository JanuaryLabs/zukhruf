import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { untilAborted } from '@zukhruf/async';
import { FencingToken } from '@zukhruf/fencing';
import { LeaseController } from '@zukhruf/lease';

import type { LockHandle } from '../../mutex/lease.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';
import { MemoryStore } from '../memory/memory-store.ts';

/**
 * One connection to SQL Server: only the methods that the store calls. No
 * driver object fits it as it is; a `Connection` of tedious fits it through a
 * small wrapper. The session must never connect again by itself.
 */
export interface SqlServerSession {
  /** Runs one batch. Each parameter is an `nvarchar`. Resolves to the rows of the batch. */
  query(
    text: string,
    parameters: Record<string, string>,
  ): Promise<Record<string, unknown>[]>;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  /** Ends the connection. The server then releases each lock of the session. */
  close(): void;
}

export interface SqlServerStoreOptions {
  /** Gives a new session. The store owns each session that it gets, and closes it. */
  connect(): Promise<SqlServerSession>;
  /** The name of an existing sequence for the fencing tokens. The store runs no DDL. */
  sequence: string;
  /**
   * Milliseconds between two heartbeats of a holder, and the time limit of
   * each heartbeat: the longest time that a holder can work after its session
   * ended, before its signal aborts.
   */
  heartbeatInterval: number;
}

/** `0` is the principal ID of `public`, the default `@DbPrincipal` of `sp_getapplock`. */
const heldQuery = `SELECT CASE WHEN EXISTS (
  SELECT 1 FROM sys.dm_tran_locks
  WHERE resource_type = N'APPLICATION'
    AND resource_database_id = DB_ID()
    AND request_status = N'GRANT'
    AND LEFT(resource_description, 36) = N'0:[' + @resource + N']'
) THEN 1 ELSE 0 END AS held`;

const waitQuery = `DECLARE @result int;
EXEC @result = sp_getapplock @Resource = @resource, @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = -1;
SELECT @result AS result;`;

const tryQuery = `DECLARE @result int;
EXEC @result = sp_getapplock @Resource = @resource, @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = 0;
SELECT @result AS result;`;

const releaseQuery = `DECLARE @result int;
EXEC @result = sp_releaseapplock @Resource = @resource, @LockOwner = 'Session';
SELECT @result AS result;`;

/** `NEXT VALUE FOR` takes no parameter, so the batch finds the sequence by name, as `regclass` does, and quotes it. */
const tokenQuery = `DECLARE @id int = OBJECT_ID(@sequence, 'SO');
IF @id IS NULL
BEGIN
  DECLARE @message nvarchar(2048) = N'The sequence ' + @sequence + N' does not exist, or the role has no permission on it.';
  THROW 50000, @message, 1;
END;
DECLARE @next nvarchar(400) = N'SELECT CAST(NEXT VALUE FOR ' + QUOTENAME(OBJECT_SCHEMA_NAME(@id)) + N'.' + QUOTENAME(OBJECT_NAME(@id)) + N' AS nvarchar(20)) AS token';
EXEC sp_executesql @next;`;

/**
 * Holds a session-owned application lock of SQL Server (`sp_getapplock`) for
 * each key, on a session of its own. The server releases the lock when the
 * session ends, so a holder that stops never leaves a key locked. Every
 * process on every machine that reaches one database shares the locks.
 *
 * Callers in this process first line up in a queue in memory, so only the
 * first one gets a session: one session per key per process, however many
 * callers wait, and first-come order within the process.
 */
export class SqlServerStore implements LockStore {
  readonly #inProcess = new MemoryStore();
  readonly #options: SqlServerStoreOptions;

  constructor(options: SqlServerStoreOptions) {
    this.#options = options;
  }

  async acquire(key: string, options?: AcquireOptions): Promise<LockHandle> {
    const signal = options?.signal;
    await using turn = new AsyncDisposableStack();
    // Joining the in-process queue is synchronous, so the order is the order of the calls.
    turn.use(await this.#inProcess.acquire(key, { signal }));
    const session = await this.#session(key, signal);
    await session.wait(signal);
    return withTurn(await session.hold(), turn);
  }

  async tryAcquire(key: string): Promise<LockHandle | undefined> {
    await using turn = new AsyncDisposableStack();
    const inProcess = await this.#inProcess.tryAcquire(key);
    if (!inProcess) return undefined;
    turn.use(inProcess);
    const session = await this.#session(key, undefined);
    if (!(await session.try())) return undefined;
    return withTurn(await session.hold(), turn);
  }

  /** Reads `sys.dm_tran_locks` on a short session. `APPLOCK_TEST` would take the lock for an instant. */
  async isHeld(key: string): Promise<boolean> {
    const session = new OwnedSession(await this.#options.connect());
    try {
      const [row] = await session.query(heldQuery, {
        resource: resourceName(key),
      });
      return row?.held === 1;
    } finally {
      session.close();
    }
  }

  /** Gets a session for `key`. A cancel never waits for `connect`: a session that comes later is closed at once. */
  async #session(
    key: string,
    signal: AbortSignal | undefined,
  ): Promise<KeySession> {
    const connecting = this.#options.connect();
    try {
      return new KeySession(
        new OwnedSession(await untilAborted(connecting, signal)),
        key,
        this.#options,
      );
    } catch (error) {
      if (signal?.aborted && error === signal.reason) {
        void connecting.then(
          (late) => late.close(),
          () => {},
        );
      }
      throw error;
    }
  }
}

/**
 * The application lock resource of `key`: the first 16 bytes of the SHA-256
 * digest of its UTF-16 code units, as 32 hex characters. Any key fits the
 * 255 characters of `@Resource`, and `sys.dm_tran_locks` shows only the first
 * 32 characters of a resource, so the holder check sees the whole name.
 */
function resourceName(key: string): string {
  return createHash('sha256')
    .update(Buffer.from(key, 'utf16le'))
    .digest()
    .subarray(0, 16)
    .toString('hex');
}

/**
 * A session from `connect` that the store owns until it closes it, once. Its
 * `ended` signal aborts when the session emits `error` or `end`. Its listeners
 * stay after the close, because a driver can emit `error` after it.
 */
class OwnedSession {
  readonly #session: SqlServerSession;
  readonly #ended = new AbortController();
  readonly #closed = new AbortController();

  constructor(session: SqlServerSession) {
    this.#session = session;
    session.on('error', (error) => this.#ended.abort(error));
    session.on('end', () =>
      this.#ended.abort(new Error('The SQL Server session ended.')),
    );
  }

  get ended(): AbortSignal {
    return this.#ended.signal;
  }

  query(
    text: string,
    parameters: Record<string, string>,
  ): Promise<Record<string, unknown>[]> {
    return this.#session.query(text, parameters);
  }

  close(): void {
    if (this.#closed.signal.aborted) return;
    this.#closed.abort();
    this.#session.close();
  }
}

/** One session for one key: it waits for the lock or tries it, then holds it with a heartbeat. */
class KeySession {
  readonly #session: OwnedSession;
  readonly #key: string;
  readonly #resource: { resource: string };
  readonly #options: SqlServerStoreOptions;
  readonly #lease: LeaseController;
  /** Aborts when the store stops holding: a release, or a lost session. */
  readonly #done = new AbortController();

  constructor(
    session: OwnedSession,
    key: string,
    options: SqlServerStoreOptions,
  ) {
    this.#session = session;
    this.#key = key;
    this.#resource = { resource: resourceName(key) };
    this.#options = options;
    this.#lease = new LeaseController(key);
  }

  /** Waits in SQL Server's lock queue. A cancel closes the session, and the end of the session releases a late grant. */
  async wait(signal: AbortSignal | undefined): Promise<void> {
    try {
      const [row] = await untilAborted(
        this.#session.query(waitQuery, this.#resource),
        signal,
      );
      if (typeof row?.result !== 'number' || row.result < 0) {
        throw new Error(
          `sp_getapplock for ${JSON.stringify(this.#key)} returned ${String(row?.result)}.`,
        );
      }
    } catch (error) {
      this.#session.close();
      throw error;
    }
  }

  async try(): Promise<boolean> {
    try {
      const [row] = await this.#session.query(tryQuery, this.#resource);
      if (row?.result === 0) return true;
      if (row?.result !== -1) {
        throw new Error(
          `sp_getapplock for ${JSON.stringify(this.#key)} returned ${String(row?.result)}.`,
        );
      }
    } catch (error) {
      this.#session.close();
      throw error;
    }
    this.#session.close();
    return false;
  }

  /** Mints the token of a granted lock and starts the heartbeat. A failed mint releases the key. */
  async hold(): Promise<LockHandle> {
    let token: FencingToken;
    try {
      const [row] = await this.#session.query(tokenQuery, {
        sequence: this.#options.sequence,
      });
      if (typeof row?.token !== 'string') {
        throw new Error(
          `NEXT VALUE FOR sequence ${JSON.stringify(this.#options.sequence)} gave no number.`,
        );
      }
      token = new FencingToken(BigInt(row.token));
    } catch (error) {
      await this.#release();
      throw error;
    }
    const ended = this.#session.ended;
    ended.addEventListener('abort', () => this.#lose(ended.reason), {
      once: true,
      signal: this.#done.signal,
    });
    void this.#beat();
    return {
      token,
      signal: this.#lease.signal,
      [Symbol.asyncDispose]: () => this.#release(),
    };
  }

  /** Sends `SELECT 1` each interval. A failed or late answer loses the lease. */
  async #beat(): Promise<void> {
    const interval = this.#options.heartbeatInterval;
    const done = this.#done.signal;
    try {
      for (;;) {
        await delay(interval, undefined, { signal: done });
        await untilAborted(
          this.#session.query('SELECT 1', {}),
          AbortSignal.any([done, AbortSignal.timeout(interval)]),
        );
      }
    } catch (cause) {
      if (!done.aborted) this.#lose(cause);
    }
  }

  /** Another holder can have the key now. */
  #lose(cause: unknown): void {
    if (this.#done.signal.aborted) return;
    this.#done.abort();
    this.#lease.lose(cause);
    this.#session.close();
  }

  /** Releases the lock on the server before the close: the server sees a closed connection a little later. */
  async #release(): Promise<void> {
    if (this.#done.signal.aborted) return;
    this.#done.abort();
    try {
      const [row] = await this.#session.query(releaseQuery, this.#resource);
      if (row?.result !== 0) {
        throw new Error(
          `The session did not hold the lock of ${JSON.stringify(this.#key)}.`,
        );
      }
    } catch (cause) {
      this.#lease.lose(cause);
      this.#session.close();
      return;
    }
    this.#lease.end();
    this.#session.close();
  }
}

/** Releases the SQL Server lock first, then lets the next caller in this process continue. */
function withTurn(handle: LockHandle, turn: AsyncDisposableStack): LockHandle {
  turn.use(handle);
  const release = turn.move();
  return {
    token: handle.token,
    signal: handle.signal,
    [Symbol.asyncDispose]: () => release.disposeAsync(),
  };
}
