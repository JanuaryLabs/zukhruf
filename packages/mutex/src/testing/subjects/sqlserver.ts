import assert from 'node:assert/strict';

import { Connection, Request, TYPES } from 'tedious';

import type { Clock } from '@zukhruf/async';
import type { DatabaseOptions } from '@zukhruf/testing/postgres';
import { SqlServer } from '@zukhruf/testing/sqlserver';

import {
  type SqlServerSession,
  SqlServerStore,
} from '../../lock-stores/sqlserver/sqlserver-store.ts';
import type { Partitionable, SessionControl } from '../contract/sessions.ts';
import {
  type Fixture,
  type Host,
  type StoreModule,
  type Subject,
  sharesWithProcesses,
  sharesWithThreads,
} from '../contract/subject.ts';
import { proxyTo } from '../tcp-proxy.ts';
import { type Server, serverAt, serverFixture } from './server.ts';

/** A column of a row that tedious gives with `useColumnNames` off, its default. */
interface Column {
  metadata: { colName: string };
  value: unknown;
}

/** The caller's wrapper that the SqlServerStore page shows: one tedious connection is one session. */
export async function sqlServerSession(
  server: Server,
): Promise<SqlServerSession> {
  const connection = new Connection({
    server: server.host,
    authentication: {
      type: 'default',
      options: { userName: server.user, password: server.password },
    },
    options: {
      port: server.port,
      database: server.database,
      encrypt: false,
      trustServerCertificate: true,
      requestTimeout: 0,
    },
  });
  await new Promise<void>((resolve, reject) =>
    connection.connect((error) => (error ? reject(error) : resolve())),
  );
  // A connection already has `on` and `close`, so the session only adds `query`.
  return Object.assign(connection, {
    query: (text: string, parameters: Record<string, string>) =>
      new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const rows: Record<string, unknown>[] = [];
        const request = new Request(text, (error) =>
          error ? reject(error) : resolve(rows),
        );
        for (const [name, value] of Object.entries(parameters)) {
          request.addParameter(name, TYPES.NVarChar, value);
        }
        request.on('row', (columns: Column[]) =>
          rows.push(
            Object.fromEntries(
              columns.map((column) => [column.metadata.colName, column.value]),
            ),
          ),
        );
        connection.execSql(request);
      }),
  });
}

/** A new database with the token sequence that the app creates before it starts. */
export async function sqlServerFixture(
  environment: DatabaseOptions['environment'],
): Promise<Fixture> {
  const database = await new SqlServer({ environment }).database();
  return serverFixture(database, async () => {
    const owner = await sqlServerSession(database);
    try {
      await owner.query(
        'CREATE SEQUENCE dbo.mutex_tokens AS bigint START WITH 1 NO CACHE',
        {},
      );
    } finally {
      owner.close();
    }
  });
}

/** The store gets a new connection for each session and closes each one, so nothing is left to end. */
export const sqlServerStore = (location: string) =>
  new SqlServerStore({
    connect: () => sqlServerSession(serverAt(location)),
    sequence: 'dbo.mutex_tokens',
    heartbeatInterval: 5_000,
    clock: globalThis,
  });

/** The store of a child process or a worker thread over `location`. */
export const openInProcess = sqlServerStore;

const module: StoreModule = {
  url: new URL(import.meta.url),
  export: 'openInProcess',
};

export const subject: Subject<Host> = {
  name: 'SqlServerStore',
  fixture: sqlServerFixture,
  open: (location) => ({
    store: sqlServerStore(location),
    async [Symbol.asyncDispose]() {},
  }),
  process: { module, admit() {} },
  grantLatency: 20,
};

export const sharing = sharesWithProcesses(subject.process);

export const threadSharing = sharesWithThreads<Host>({ module, admit() {} });

const storeOn = (
  connect: () => Promise<SqlServerSession>,
  heartbeatInterval: number,
  clock: Clock,
) =>
  new SqlServerStore({
    connect,
    sequence: 'dbo.mutex_tokens',
    heartbeatInterval,
    clock,
  });

/** Runs `text` on a session of the test, not of a store. */
async function observe(location: string, text: string) {
  const session = await sqlServerSession(serverAt(location));
  try {
    return await session.query(text, {});
  } finally {
    session.close();
  }
}

export const partitionable: Partitionable = {
  heartbeatInterval: 200,
  async partitionable(location, clock) {
    const server = serverAt(location);
    const proxy = await proxyTo(server);
    return {
      store: storeOn(
        () =>
          sqlServerSession({ ...server, host: proxy.host, port: proxy.port }),
        this.heartbeatInterval,
        clock,
      ),
      partition: () => proxy.partition(),
      [Symbol.asyncDispose]: () => proxy[Symbol.asyncDispose](),
    };
  },
};

/**
 * A session that connects again by itself when the server ends its
 * connection, and tells the store nothing, as the `ConnectionPool` of mssql
 * does. The store's listeners hear nothing. A query that fails on the ended
 * connection runs again on the new one. `reconnected` resolves once the new
 * connection is up.
 * Queries on the new connection wait until `resume()`, so the test
 * decides when the store sees it.
 */
async function silentlyReconnectingSession(server: Server) {
  const open = async () => {
    const connection = await sqlServerSession(server);
    connection.on('error', () => {});
    return connection;
  };
  let current = await open();
  const [first] = await current.query('SELECT @@SPID AS id', {});
  const reconnected = Promise.withResolvers<void>();
  const resumed = Promise.withResolvers<void>();
  let reconnectedYet = false;
  current.on('end', () => {
    open().then((next) => {
      current = next;
      reconnectedYet = true;
      reconnected.resolve();
    }, reconnected.reject);
  });
  const session: SqlServerSession = {
    query: async (text, parameters) => {
      try {
        if (!reconnectedYet) return await current.query(text, parameters);
      } catch {
        await reconnected.promise;
      }
      await resumed.promise;
      return current.query(text, parameters);
    },
    on: () => session,
    close: () => current.close(),
  };
  return {
    session,
    id: Number(first?.id),
    reconnected: reconnected.promise,
    resume: () => resumed.resolve(),
  };
}

export const sessionControl: SessionControl = {
  async watched(location, heartbeatInterval) {
    const server = serverAt(location);
    return {
      store: storeOn(
        () => sqlServerSession(server),
        heartbeatInterval,
        globalThis,
      ),
      async killHolder() {
        const [holder] = await observe(
          location,
          `SELECT request_session_id AS id FROM sys.dm_tran_locks
           WHERE resource_type = N'APPLICATION' AND resource_database_id = DB_ID() AND request_status = N'GRANT'`,
        );
        assert.ok(holder, 'A session must hold an application lock');
        await observe(location, `KILL ${Number(holder.id)}`);
      },
      async [Symbol.asyncDispose]() {},
    };
  },
  async silentlyReconnecting(location, heartbeatInterval) {
    const reconnecting = await silentlyReconnectingSession(serverAt(location));
    return {
      store: storeOn(
        async () => reconnecting.session,
        heartbeatInterval,
        globalThis,
      ),
      async kill() {
        await observe(location, `KILL ${reconnecting.id}`);
      },
      reconnected: reconnecting.reconnected,
      resume: reconnecting.resume,
      async [Symbol.asyncDispose]() {
        reconnecting.resume();
      },
    };
  },
  async untilASessionWaits(t, location) {
    await t.waitFor(
      async () => {
        const rows = await observe(
          location,
          `SELECT count(*) AS waiting FROM sys.dm_tran_locks
           WHERE resource_type = N'APPLICATION' AND resource_database_id = DB_ID() AND request_status = N'WAIT'`,
        );
        assert.ok(Number(rows[0]?.waiting) > 0, 'No session waits for a lock.');
      },
      { interval: 10, timeout: 10_000 },
    );
  },
};
