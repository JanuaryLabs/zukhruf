import {
  type GetLockServer,
  type GetLockSession,
  getLockDialect,
  lockName,
  quoteName,
} from '../mysql/get-lock-dialect.ts';
import { SessionLockStore } from '../session/session-lock-store.ts';

/**
 * One connection to the MariaDB server: only the methods that the store
 * calls. A `PoolConnection` of `mariadb` (MariaDB Connector/Node.js) fits it.
 */
export interface MariadbSession extends GetLockSession {
  query(sql: string, values: unknown[]): Promise<unknown>;
  /** Gives the session back to its pool. It never rejects. */
  release(): Promise<void>;
}

export interface MariadbStoreOptions {
  /** Gives a new session. The store owns each session that it gets. */
  connect(): Promise<MariadbSession>;
  /** The name of an existing sequence in the database of the session, for the fencing tokens. The store runs no DDL. */
  sequence: string;
  /**
   * Milliseconds between two heartbeats of a holder, and the time limit of
   * each heartbeat: the longest time that a holder can work after its session
   * ended, before its signal aborts.
   */
  heartbeatInterval: number;
}

/**
 * MariaDB's longest `GET_LOCK` timeout that the store uses: one year, in
 * seconds. A negative timeout gives NULL, and a timeout that ends after
 * 2^64 nanoseconds since 1970 gives 0 at once.
 */
const oneYear = 31_536_000;

/**
 * Holds a MariaDB user lock (`GET_LOCK`) for each key, on a session of its
 * own. The server releases the lock when the session ends, so a holder that
 * stops never leaves a key locked. Every process on every machine that
 * reaches one MariaDB database shares the locks.
 */
export class MariadbStore extends SessionLockStore<MariadbSession> {
  constructor({ connect, sequence, heartbeatInterval }: MariadbStoreOptions) {
    super(
      { connect, heartbeatInterval },
      getLockDialect(mariadbServer(quoteName(sequence))),
    );
  }
}

function mariadbServer(sequence: string): GetLockServer<MariadbSession> {
  return {
    server: 'MariaDB',
    // The session's max_statement_time makes a waiting GET_LOCK give NULL.
    waitStatement: `SET STATEMENT max_statement_time = 0 FOR SELECT GET_LOCK(${lockName}, ${oneYear}) AS locked`,
    run: (session, sql, values) => session.query(sql, values),
    giveBack: (session) => void session.release(),
    mint: async (run) => {
      const row = await run(
        `SELECT CAST(NEXTVAL(${sequence}) AS CHAR) AS token`,
        [],
      );
      if (typeof row?.['token'] !== 'string') {
        throw new Error(`NEXTVAL of sequence ${sequence} gave no number.`);
      }
      return BigInt(row['token']);
    },
  };
}
