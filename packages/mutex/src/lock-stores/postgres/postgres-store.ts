import { untilAborted } from '@zukhruf/async';

import { keyDigest } from '../../shared/key-digest.ts';
import {
  type SessionLockDialect,
  SessionLockStore,
} from '../session/session-lock-store.ts';

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

/** The granted advisory locks of a lock number in the database of the session. */
const lockRows = `FROM pg_catalog.pg_locks
  WHERE locktype = 'advisory'
    AND database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())
    AND objsubid = 1
    AND ((classid::bigint << 32) | objid::bigint) = $1::bigint
    AND granted`;

const heldQuery = `SELECT EXISTS (SELECT 1 ${lockRows}) AS held`;

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
export class PostgresStore extends SessionLockStore<PostgresSession> {
  constructor(options: PostgresStoreOptions) {
    super(options, postgresDialect(options));
  }
}

/**
 * The number of the advisory lock of `key`: the first 8 bytes of the key
 * digest, as a signed 64-bit integer. Sent as text, because a JavaScript
 * number cannot hold 64 bits.
 */
function lockNumber(key: string): string {
  return keyDigest(key).readBigInt64BE(0).toString();
}

const rowsOf = async (
  session: PostgresSession,
  text: string,
  values: unknown[],
) => (await session.query(text, values)).rows;

function postgresDialect(
  options: PostgresStoreOptions,
): SessionLockDialect<PostgresSession> {
  return {
    server: 'Postgres',
    lockName: lockNumber,
    wait: async (session, { name }, signal) => {
      // A timeout of the pool must not stop the wait.
      await session.query(
        'SET statement_timeout = 0; SET lock_timeout = 0',
        [],
      );
      await untilAborted(
        session.query('SELECT pg_advisory_lock($1::bigint)', [name]),
        signal,
      );
    },
    try: async (session, { name }) => {
      const [row] = await rowsOf(
        session,
        'SELECT pg_try_advisory_lock($1::bigint) AS locked',
        [name],
      );
      return row?.locked === true;
    },
    mint: async (session) => {
      const [row] = await rowsOf(
        session,
        'SELECT nextval($1::regclass)::text AS token',
        [options.sequence],
      );
      if (typeof row?.token !== 'string') {
        throw new Error(
          `nextval of sequence ${JSON.stringify(options.sequence)} gave no number.`,
        );
      }
      return BigInt(row.token);
    },
    heartbeat: async (session) => {
      await session.query('SELECT 1', []);
    },
    release: async (session, { name }) => {
      const [row] = await rowsOf(
        session,
        'SELECT pg_advisory_unlock($1::bigint) AS released',
        [name],
      );
      if (row?.released !== true) return false;
      await session.query('RESET statement_timeout; RESET lock_timeout', []);
      return true;
    },
    /** Reads `pg_locks`, and never runs an advisory lock function. */
    isHeld: async (session, { name }) => {
      const [row] = await rowsOf(session, heldQuery, [name]);
      return row?.held === true;
    },
    detach: (session, { error, end }) => {
      session.off('error', error);
      session.off('end', end);
    },
    // The session holds nothing: it goes back to the pool with its own settings.
    giveBack: (session) => session.release(false),
    destroy: (session) => session.release(true),
  };
}
