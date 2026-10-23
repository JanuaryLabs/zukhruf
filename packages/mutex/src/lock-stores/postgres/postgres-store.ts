import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { untilAborted } from '@zukhruf/async';
import { FencingToken } from '@zukhruf/fencing';
import { LeaseController } from '@zukhruf/lease';

import type { LockHandle } from '../../mutex/lease.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';
import { InProcessTurns } from '../../shared/in-process-turns.ts';

/**
 * One connection to the Postgres server: only the methods that the store
 * calls. A `PoolClient` of `pg` (node-postgres) fits it.
 */
export interface PostgresSession {
  query(
    text: string,
    values: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  off(event: 'error' | 'end', listener: (error: Error) => void): unknown;
  /** `true` destroys the session; `false` gives it back to its pool. */
  release(destroy: boolean): void;
}

export interface PostgresStoreOptions {
  /** Gives a new session. The store owns each session that it gets. */
  connect(): Promise<PostgresSession>;
  /** The name of an existing sequence for the fencing tokens. The store runs no DDL. */
  sequence: string;
  /**
   * Milliseconds between two heartbeats of a holder, and the time limit of
   * each heartbeat: the longest time that a holder can work after its session
   * ended, before its signal aborts.
   */
  heartbeatInterval: number;
}

const heldQuery = `SELECT EXISTS (
  SELECT 1 FROM pg_catalog.pg_locks
  WHERE locktype = 'advisory'
    AND database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())
    AND objsubid = 1
    AND ((classid::bigint << 32) | objid::bigint) = $1::bigint
    AND granted
) AS held`;

/**
 * Holds a session-level advisory lock of Postgres for each key, on a session
 * of its own. The server releases the lock when the session ends, so a
 * holder that stops never leaves a key locked. Every process on every machine
 * that reaches one database shares the locks.
 *
 * Callers in this process first line up in a queue in memory, so only the
 * first one gets a session: one session per key per process, however many
 * callers wait, and first-come order within the process.
 */
export class PostgresStore implements LockStore {
  readonly #turns = new InProcessTurns();
  readonly #options: PostgresStoreOptions;

  constructor(options: PostgresStoreOptions) {
    this.#options = options;
  }

  acquire(key: string, options?: AcquireOptions): Promise<LockHandle> {
    return this.#turns.acquire(key, options, async () => {
      const signal = options?.signal;
      const session = await this.#session(key, signal);
      await session.wait(signal);
      return session.hold();
    });
  }

  tryAcquire(key: string): Promise<LockHandle | undefined> {
    return this.#turns.tryAcquire(key, async () => {
      const session = await this.#session(key, undefined);
      if (!(await session.try())) return undefined;
      return session.hold();
    });
  }

  /** Reads `pg_locks` on a short session, and never runs an advisory lock function. */
  async isHeld(key: string): Promise<boolean> {
    const session = new OwnedSession(await this.#options.connect());
    try {
      const [row] = await session.query(heldQuery, [lockNumber(key)]);
      session.giveBack();
      return row?.held === true;
    } catch (error) {
      session.destroy();
      throw error;
    }
  }

  /** Gets a session for `key`. A cancel never waits for the pool: a session that comes later goes back at once. */
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
          (late) => late.release(false),
          () => {},
        );
      }
      throw error;
    }
  }
}

/**
 * The number of the advisory lock of `key`: the first 8 bytes of the SHA-256
 * digest of its UTF-16 code units, as a signed 64-bit integer. The code units,
 * not UTF-8, so that keys that differ only in a lone surrogate get different
 * numbers. Sent as text, because a JavaScript number cannot hold 64 bits.
 */
function lockNumber(key: string): string {
  return createHash('sha256')
    .update(Buffer.from(key, 'utf16le'))
    .digest()
    .readBigInt64BE(0)
    .toString();
}

/**
 * A session from `connect` that the store owns until it gives it back or
 * destroys it, once. Its `ended` signal aborts when the session emits `error`
 * or `end`. Its listeners stay on a destroyed session, because node-postgres
 * can emit `error` again after the close.
 */
class OwnedSession {
  readonly #session: PostgresSession;
  readonly #ended = new AbortController();
  readonly #owned = new AbortController();
  readonly #onError = (error: Error) => this.#ended.abort(error);
  readonly #onEnd = () =>
    this.#ended.abort(new Error('The Postgres session ended.'));

  constructor(session: PostgresSession) {
    this.#session = session;
    session.on('error', this.#onError);
    session.on('end', this.#onEnd);
  }

  get ended(): AbortSignal {
    return this.#ended.signal;
  }

  async query(
    text: string,
    values: unknown[],
  ): Promise<Record<string, unknown>[]> {
    return (await this.#session.query(text, values)).rows;
  }

  /** The session holds nothing: it goes back to the pool with its own settings. */
  giveBack(): void {
    if (this.#owned.signal.aborted) return;
    this.#owned.abort();
    this.#session.off('error', this.#onError);
    this.#session.off('end', this.#onEnd);
    this.#session.release(false);
  }

  /** The lock state of the session is not known: the server releases each lock of a session that ends. */
  destroy(): void {
    if (this.#owned.signal.aborted) return;
    this.#owned.abort();
    this.#session.release(true);
  }
}

/** One session for one key: it waits for the lock or tries it, then holds it with a heartbeat. */
class KeySession {
  readonly #session: OwnedSession;
  readonly #key: string;
  readonly #number: string;
  readonly #options: PostgresStoreOptions;
  readonly #lease: LeaseController;
  /** Aborts when the store stops holding: a release, or a lost session. */
  readonly #done = new AbortController();

  constructor(
    session: OwnedSession,
    key: string,
    options: PostgresStoreOptions,
  ) {
    this.#session = session;
    this.#key = key;
    this.#number = lockNumber(key);
    this.#options = options;
    this.#lease = new LeaseController(key);
  }

  /** Waits in Postgres' lock queue. A cancel closes the session, and the end of the session releases a late grant. */
  async wait(signal: AbortSignal | undefined): Promise<void> {
    try {
      // A timeout of the pool must not stop the wait.
      await this.#session.query(
        'SET statement_timeout = 0; SET lock_timeout = 0',
        [],
      );
      await untilAborted(
        this.#session.query('SELECT pg_advisory_lock($1::bigint)', [
          this.#number,
        ]),
        signal,
      );
    } catch (error) {
      this.#session.destroy();
      throw error;
    }
  }

  async try(): Promise<boolean> {
    try {
      const [row] = await this.#session.query(
        'SELECT pg_try_advisory_lock($1::bigint) AS locked',
        [this.#number],
      );
      if (row?.locked === true) return true;
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
      const [row] = await this.#session.query(
        'SELECT nextval($1::regclass)::text AS token',
        [this.#options.sequence],
      );
      if (typeof row?.token !== 'string') {
        throw new Error(
          `nextval of sequence ${JSON.stringify(this.#options.sequence)} gave no number.`,
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
          this.#session.query('SELECT 1', []),
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
      const [row] = await this.#session.query(
        'SELECT pg_advisory_unlock($1::bigint) AS released',
        [this.#number],
      );
      if (row?.released !== true) {
        throw new Error(
          `The session did not hold the lock of ${JSON.stringify(this.#key)}.`,
        );
      }
      await this.#session.query(
        'RESET statement_timeout; RESET lock_timeout',
        [],
      );
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
