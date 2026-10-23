import type { LockHandle } from '../../mutex/lease.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';
import {
  type GetLockDialect,
  type GetLockSession,
  GetLockStore,
  lockName,
  quoteName,
} from './get-lock-session.ts';

/**
 * One connection to the MySQL server: only the methods that the store calls.
 * A `PoolConnection` of `mysql2/promise` fits it.
 */
export interface MysqlSession extends GetLockSession {
  query(sql: string, values: unknown[]): Promise<[unknown, unknown]>;
  /** Gives the session back to its pool. */
  release(): void;
}

export interface MysqlStoreOptions {
  /** Gives a new session. The store owns each session that it gets. */
  connect(): Promise<MysqlSession>;
  /**
   * The name of an existing table in the database of the session, with one
   * row and one `BIGINT UNSIGNED` column `id`, for the fencing tokens. The
   * store runs no DDL.
   */
  table: string;
  /**
   * Milliseconds between two heartbeats of a holder, and the time limit of
   * each heartbeat: the longest time that a holder can work after its session
   * ended, before its signal aborts.
   */
  heartbeatInterval: number;
}

/**
 * Holds a MySQL user lock (`GET_LOCK`) for each key, on a session of its own.
 * The server releases the lock when the session ends, so a holder that stops
 * never leaves a key locked. Every process on every machine that reaches one
 * MySQL database shares the locks.
 */
export class MysqlStore implements LockStore {
  readonly #store: GetLockStore<MysqlSession>;

  constructor({ connect, table, heartbeatInterval }: MysqlStoreOptions) {
    this.#store = new GetLockStore({
      connect,
      heartbeatInterval,
      dialect: mysqlDialect(quoteName(table)),
    });
  }

  acquire(key: string, options?: AcquireOptions): Promise<LockHandle> {
    return this.#store.acquire(key, options);
  }

  tryAcquire(key: string): Promise<LockHandle | undefined> {
    return this.#store.tryAcquire(key);
  }

  isHeld(key: string): Promise<boolean> {
    return this.#store.isHeld(key);
  }
}

function mysqlDialect(table: string): GetLockDialect<MysqlSession> {
  return {
    server: 'MySQL',
    // A negative timeout waits with no limit. The hint lifts the session's
    // max_execution_time, which interrupts a waiting GET_LOCK.
    waitStatement: `SELECT /*+ SET_VAR(max_execution_time = 0) */ GET_LOCK(${lockName}, -1) AS locked`,
    run: async (session, sql, values) => (await session.query(sql, values))[0],
    giveBack: (session) => session.release(),
    // The sequence of the MySQL manual (LAST_INSERT_ID(expr)). An UPDATE that
    // changes no row leaves LAST_INSERT_ID() at the session's last token.
    mint: async (run) => {
      await run(`UPDATE ${table} SET id = LAST_INSERT_ID(id + 1)`, []);
      const row = await run(
        'SELECT CAST(LAST_INSERT_ID() AS CHAR) AS token, ROW_COUNT() AS updated',
        [],
      );
      const updated = Number(row?.['updated']);
      if (updated !== 1 || typeof row?.['token'] !== 'string') {
        throw new Error(
          `The token table ${table} must have exactly one row; the update changed ${updated}.`,
        );
      }
      return BigInt(row['token']);
    },
  };
}
