import { untilAborted } from '@zukhruf/async';

import { keyDigest } from '../../shared/key-digest.ts';
import {
  type SessionLockDialect,
  SessionLockStore,
} from '../session/session-lock-store.ts';

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
export class SqlServerStore extends SessionLockStore<SqlServerSession> {
  constructor(options: SqlServerStoreOptions) {
    super(options, sqlServerDialect(options));
  }
}

/**
 * The application lock resource of `key`: the first 16 bytes of the key
 * digest, as 32 hex characters. Any key fits the 255 characters of
 * `@Resource`, and `sys.dm_tran_locks` shows only the first 32 characters of
 * a resource, so the holder check sees the whole name.
 */
function resourceName(key: string): string {
  return keyDigest(key).subarray(0, 16).toString('hex');
}

function sqlServerDialect(
  options: SqlServerStoreOptions,
): SessionLockDialect<SqlServerSession> {
  return {
    server: 'SQL Server',
    lockName: resourceName,
    wait: async (session, { key, name }, signal) => {
      const [row] = await untilAborted(
        session.query(waitQuery, { resource: name }),
        signal,
      );
      if (typeof row?.result !== 'number' || row.result < 0) {
        throw new Error(
          `sp_getapplock for ${JSON.stringify(key)} returned ${String(row?.result)}.`,
        );
      }
    },
    try: async (session, { key, name }) => {
      const [row] = await session.query(tryQuery, { resource: name });
      if (row?.result === 0) return true;
      if (row?.result !== -1) {
        throw new Error(
          `sp_getapplock for ${JSON.stringify(key)} returned ${String(row?.result)}.`,
        );
      }
      return false;
    },
    mint: async (session) => {
      const [row] = await session.query(tokenQuery, {
        sequence: options.sequence,
      });
      if (typeof row?.token !== 'string') {
        throw new Error(
          `NEXT VALUE FOR sequence ${JSON.stringify(options.sequence)} gave no number.`,
        );
      }
      return BigInt(row.token);
    },
    heartbeat: async (session) => {
      await session.query('SELECT 1', {});
    },
    // Releases the lock on the server before the close: the server sees a closed connection a little later.
    release: async (session, { name }) => {
      const [row] = await session.query(releaseQuery, { resource: name });
      return row?.result === 0;
    },
    /** Reads `sys.dm_tran_locks`. `APPLOCK_TEST` would take the lock for an instant. */
    isHeld: async (session, { name }) => {
      const [row] = await session.query(heldQuery, { resource: name });
      return row?.held === 1;
    },
    // A closed session keeps its listeners, because a driver can emit `error` after the close.
    detach: () => {},
    giveBack: (session) => session.close(),
    destroy: (session) => session.close(),
  };
}
