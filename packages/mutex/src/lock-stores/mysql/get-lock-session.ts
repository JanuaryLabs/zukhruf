import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { untilAborted } from '@zukhruf/async';
import { FencingToken } from '@zukhruf/fencing';
import { LeaseController } from '@zukhruf/lease';

import type { LockHandle } from '../../mutex/lease.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';
import { MemoryStore } from '../memory/memory-store.ts';

/** The events and the close of one connection to a server of the MySQL family: the parts that both drivers share. */
export interface GetLockSession {
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  off(event: 'error' | 'end', listener: (error: Error) => void): unknown;
  /** Closes the connection; the server then releases each user lock of the session. */
  destroy(): void;
}

export type Row = Record<string, unknown>;

/** Runs one statement on the session and gives its first row, if it gives rows. */
export type RunStatement = (
  sql: string,
  values: unknown[],
) => Promise<Row | undefined>;

/** What differs between MySQL and MariaDB, and between their drivers. */
export interface GetLockDialect<Session extends GetLockSession> {
  /** The name of the server in error messages. */
  readonly server: string;
  /**
   * `SELECT GET_LOCK(${lockName}, <timeout>) AS locked`, with the longest timeout of
   * the server, and free of the time limit of a statement of the session.
   */
  readonly waitStatement: string;
  /** Runs a statement with the driver, and gives the result: the rows of a SELECT. */
  run(session: Session, sql: string, values: unknown[]): Promise<unknown>;
  /** Gives a session that holds nothing back to its pool. */
  giveBack(session: Session): void;
  /** Gives the next fencing token from the object that the caller created. */
  mint(run: RunStatement): Promise<bigint>;
}

export interface GetLockStoreOptions<Session extends GetLockSession> {
  connect(): Promise<Session>;
  heartbeatInterval: number;
  dialect: GetLockDialect<Session>;
}

/**
 * Holds a user lock (`GET_LOCK`) for each key, on a session of its own. The
 * server releases the lock when the session ends. The name of each lock
 * includes the database of the session, so the locks belong to one database.
 *
 * Callers in this process first line up in a queue in memory, so only the
 * first one gets a session: one session per key per process, however many
 * callers wait, and first-come order within the process.
 */
export class GetLockStore<Session extends GetLockSession> implements LockStore {
  readonly #inProcess = new MemoryStore();
  readonly #options: GetLockStoreOptions<Session>;

  constructor(options: GetLockStoreOptions<Session>) {
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

  /** Reads `IS_USED_LOCK` on a short session, which never acquires the lock. A session with no database fails. */
  async isHeld(key: string): Promise<boolean> {
    const session = new OwnedSession(
      await this.#options.connect(),
      this.#options.dialect,
    );
    try {
      const row = await session.run(
        `SELECT IS_USED_LOCK(${lockName}) AS holder, DATABASE() AS db`,
        [keyDigest(key)],
      );
      if (row?.['db'] === null) {
        throw new Error(
          `The ${this.#options.dialect.server} session has no database.`,
        );
      }
      session.giveBack();
      return row?.['holder'] !== null;
    } catch (error) {
      session.destroy();
      throw error;
    }
  }

  /** Gets a session for `key`. A cancel never waits for the pool: a session that comes later goes back at once. */
  async #session(
    key: string,
    signal: AbortSignal | undefined,
  ): Promise<KeySession<Session>> {
    const { connect, dialect } = this.#options;
    const connecting = connect();
    try {
      return new KeySession(
        new OwnedSession(await untilAborted(connecting, signal), dialect),
        key,
        this.#options,
      );
    } catch (error) {
      if (signal?.aborted && error === signal.reason) {
        void connecting.then(
          (late) => dialect.giveBack(late),
          () => {},
        );
      }
      throw error;
    }
  }
}

/**
 * The digest of `key` that the client sends: the SHA-256 digest of its UTF-16
 * code units, as 64 lowercase hex characters. The code units, not UTF-8, so
 * that keys that differ only in a lone surrogate get different digests.
 */
function keyDigest(key: string): string {
  return createHash('sha256').update(Buffer.from(key, 'utf16le')).digest('hex');
}

/**
 * The name of the user lock, made on the server from the database of the
 * session and the digest of the key (the one `?`). A user lock belongs to
 * the whole server, but the token source belongs to one database, so the
 * lock belongs to one database too. SHA-256 gives 64 lowercase hex
 * characters: the limit of MySQL, and the same under a comparison with or
 * without case. With no database, the name is NULL, and the statement fails.
 */
export const lockName = "SHA2(CONCAT(DATABASE(), ':', ?), 256)";

/** `GET_LOCK` gives 1 for a grant and 0 for a timeout; NULL is an error, for example a killed statement. */
function granted(row: Row | undefined, server: string): boolean {
  const locked = row?.['locked'];
  if (locked === null || locked === undefined) {
    throw new Error(`GET_LOCK of ${server} gave NULL.`);
  }
  return Number(locked) === 1;
}

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null;
}

/**
 * A session from `connect` that the store owns until it gives it back or
 * destroys it, once. Its `ended` signal aborts when the session emits `error`
 * or `end`. Its listeners stay on a destroyed session, so that a late `error`
 * has a listener.
 */
class OwnedSession<Session extends GetLockSession> {
  readonly #session: Session;
  readonly #dialect: GetLockDialect<Session>;
  readonly #ended = new AbortController();
  readonly #owned = new AbortController();
  readonly #onError = (error: Error) => this.#ended.abort(error);
  readonly #onEnd = () =>
    this.#ended.abort(new Error(`The ${this.#dialect.server} session ended.`));

  constructor(session: Session, dialect: GetLockDialect<Session>) {
    this.#session = session;
    this.#dialect = dialect;
    session.on('error', this.#onError);
    session.on('end', this.#onEnd);
  }

  get ended(): AbortSignal {
    return this.#ended.signal;
  }

  readonly run: RunStatement = async (sql, values) => {
    const result = await this.#dialect.run(this.#session, sql, values);
    if (!Array.isArray(result)) return undefined;
    const first: unknown = result[0];
    return isRow(first) ? first : undefined;
  };

  /** The session holds nothing: it goes back to the pool. */
  giveBack(): void {
    if (this.#owned.signal.aborted) return;
    this.#owned.abort();
    this.#session.off('error', this.#onError);
    this.#session.off('end', this.#onEnd);
    this.#dialect.giveBack(this.#session);
  }

  /** The lock state of the session is not known: the server releases each user lock of a session that ends. */
  destroy(): void {
    if (this.#owned.signal.aborted) return;
    this.#owned.abort();
    this.#session.destroy();
  }
}

/** One session for one key: it waits for the lock or tries it, then holds it with a heartbeat. */
class KeySession<Session extends GetLockSession> {
  readonly #session: OwnedSession<Session>;
  readonly #key: string;
  readonly #digest: string;
  readonly #options: GetLockStoreOptions<Session>;
  readonly #lease: LeaseController;
  /** Aborts when the store stops holding: a release, or a lost session. */
  readonly #done = new AbortController();

  constructor(
    session: OwnedSession<Session>,
    key: string,
    options: GetLockStoreOptions<Session>,
  ) {
    this.#session = session;
    this.#key = key;
    this.#digest = keyDigest(key);
    this.#options = options;
    this.#lease = new LeaseController(key);
  }

  /**
   * Waits in the server's queue of the lock. A cancel closes the session, and
   * the end of the session releases a late grant. A timeout of `GET_LOCK`
   * (MariaDB's longest is one year) waits again.
   */
  async wait(signal: AbortSignal | undefined): Promise<void> {
    const { dialect } = this.#options;
    try {
      for (;;) {
        const row = await untilAborted(
          this.#session.run(dialect.waitStatement, [this.#digest]),
          signal,
        );
        if (granted(row, dialect.server)) return;
      }
    } catch (error) {
      this.#session.destroy();
      throw error;
    }
  }

  async try(): Promise<boolean> {
    try {
      const row = await this.#session.run(
        `SELECT GET_LOCK(${lockName}, 0) AS locked`,
        [this.#digest],
      );
      if (granted(row, this.#options.dialect.server)) return true;
    } catch (error) {
      this.#session.destroy();
      throw error;
    }
    this.#session.giveBack();
    return false;
  }

  /** Mints the token of a granted lock and starts the heartbeat. A failed mint releases the key. */
  async hold(): Promise<LockHandle> {
    let token: FencingToken;
    try {
      token = new FencingToken(
        await this.#options.dialect.mint(this.#session.run),
      );
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
          this.#session.run('SELECT 1', []),
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
    this.#session.destroy();
  }

  async #release(): Promise<void> {
    if (this.#done.signal.aborted) return;
    this.#done.abort();
    try {
      const row = await this.#session.run(
        `SELECT RELEASE_LOCK(${lockName}) AS released`,
        [this.#digest],
      );
      if (Number(row?.['released']) !== 1) {
        throw new Error(
          `The session did not hold the lock of ${JSON.stringify(this.#key)}.`,
        );
      }
    } catch (cause) {
      // A plain release would give the next borrower a lock that this session may still hold.
      this.#lease.lose(cause);
      this.#session.destroy();
      return;
    }
    this.#lease.end();
    this.#session.giveBack();
  }
}

/** Releases the user lock first, then lets the next caller in this process continue. */
function withTurn(handle: LockHandle, turn: AsyncDisposableStack): LockHandle {
  turn.use(handle);
  const release = turn.move();
  return {
    token: handle.token,
    signal: handle.signal,
    [Symbol.asyncDispose]: () => release.disposeAsync(),
  };
}

/** Quotes one identifier for MySQL and MariaDB. */
export function quoteName(name: string): string {
  return `\`${name.replaceAll('`', '``')}\``;
}
