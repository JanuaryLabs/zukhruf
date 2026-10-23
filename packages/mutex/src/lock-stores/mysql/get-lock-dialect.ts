import { untilAborted } from '@zukhruf/async';

import { keyDigest } from '../../shared/key-digest.ts';
import type { SessionLockDialect } from '../session/session-lock-store.ts';

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
export interface GetLockServer<Session extends GetLockSession> {
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
 * The dialect of a user lock (`GET_LOCK`) for each key. The name of each lock
 * includes the database of the session, so the locks belong to one database.
 * The client sends the key digest as 64 lowercase hex characters.
 */
export function getLockDialect<Session extends GetLockSession>(
  server: GetLockServer<Session>,
): SessionLockDialect<Session> {
  const runOn =
    (session: Session): RunStatement =>
    async (sql, values) => {
      const result = await server.run(session, sql, values);
      if (!Array.isArray(result)) return undefined;
      const first: unknown = result[0];
      return isRow(first) ? first : undefined;
    };
  return {
    server: server.server,
    lockName: (key) => keyDigest(key).toString('hex'),
    // A timeout of `GET_LOCK` (MariaDB's longest is one year) waits again.
    wait: async (session, { name }, signal) => {
      for (;;) {
        const row = await untilAborted(
          runOn(session)(server.waitStatement, [name]),
          signal,
        );
        if (granted(row, server.server)) return;
      }
    },
    try: async (session, { name }) =>
      granted(
        await runOn(session)(`SELECT GET_LOCK(${lockName}, 0) AS locked`, [
          name,
        ]),
        server.server,
      ),
    mint: (session) => server.mint(runOn(session)),
    // `IS_USED_LOCK` never acquires the lock. It gives NULL for a free lock.
    holds: async (session, { name }) => {
      const row = await runOn(session)(
        `SELECT IS_USED_LOCK(${lockName}) = CONNECTION_ID() AS held`,
        [name],
      );
      return Number(row?.['held']) === 1;
    },
    release: async (session, { name }) => {
      const row = await runOn(session)(
        `SELECT RELEASE_LOCK(${lockName}) AS released`,
        [name],
      );
      return Number(row?.['released']) === 1;
    },
    /** Reads `IS_USED_LOCK`, which never acquires the lock. A session with no database fails. */
    isHeld: async (session, { name }) => {
      const row = await runOn(session)(
        `SELECT IS_USED_LOCK(${lockName}) AS holder, DATABASE() AS db`,
        [name],
      );
      if (row?.['db'] === null) {
        throw new Error(`The ${server.server} session has no database.`);
      }
      return row?.['holder'] !== null;
    },
    detach: (session, { error, end }) => {
      session.off('error', error);
      session.off('end', end);
    },
    giveBack: (session) => server.giveBack(session),
    destroy: (session) => session.destroy(),
  };
}

/** Quotes one identifier for MySQL and MariaDB. */
export function quoteName(name: string): string {
  return `\`${name.replaceAll('`', '``')}\``;
}
