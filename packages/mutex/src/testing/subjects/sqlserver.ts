import { Connection, Request, TYPES } from 'tedious';

import type { Clock } from '@zukhruf/async';
import type { DatabaseOptions } from '@zukhruf/testing/postgres';
import { SqlServer } from '@zukhruf/testing/sqlserver';

import {
  type SqlServerSession,
  SqlServerStore,
} from '../../lock-stores/sqlserver/sqlserver-store.ts';
import type { Partitionable } from '../contract/sessions.ts';
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

/** A new database with the lease table and the token sequence that the app creates before it starts. */
export async function sqlServerFixture(
  environment: DatabaseOptions['environment'],
): Promise<Fixture> {
  const database = await new SqlServer({ environment }).database();
  return serverFixture(database, async () => {
    const owner = await sqlServerSession(database);
    try {
      await owner.query(
        `CREATE TABLE dbo.mutex_leases (name binary(16) NOT NULL PRIMARY KEY, holder uniqueidentifier NULL, token bigint NOT NULL, renewed datetime2 NOT NULL, duration int NOT NULL);
         CREATE SEQUENCE dbo.mutex_tokens AS bigint START WITH 1 NO CACHE;`,
        {},
      );
    } finally {
      owner.close();
    }
  });
}

/** A store over `connect` with the table and the sequence of the fixture. */
export const sqlServerStoreOn = (
  connect: () => Promise<SqlServerSession>,
  options: {
    heartbeatInterval: number;
    leaseDuration?: number;
    clock: Clock;
  },
) =>
  new SqlServerStore({
    connect,
    table: 'dbo.mutex_leases',
    sequence: 'dbo.mutex_tokens',
    ...options,
  });

type Connected = Awaited<ReturnType<typeof sqlServerSession>>;

/**
 * Connected sessions of `server`, as a host keeps them: `connect` gives an
 * idle one or connects a new one, and its `close` gives it back. An idle
 * session closes after 1 s on a timer that keeps nothing alive, so a worker
 * thread whose store is idle can exit; a session whose query failed closes.
 * A new connection for each statement took 0.6 to 1.3 s over a link of about
 * 80 ms, more than a renewal has (#5973).
 */
function sessionsOf(server: Server) {
  const idle: { connected: Connected; timer: NodeJS.Timeout }[] = [];
  const open = new Set<Connected>();
  const lend = (connected: Connected): SqlServerSession => {
    // The phases of one loan, each with what its close does: a lent session
    // goes back to the pool, a broken one closes, a returned one does nothing.
    const returned = { close: () => {} };
    const broken = {
      close: () => {
        open.delete(connected);
        connected.close();
      },
    };
    const lent = {
      close: () => {
        const timer = setTimeout(() => {
          const index = idle.findIndex(
            (entry) => entry.connected === connected,
          );
          if (index !== -1) idle.splice(index, 1);
          broken.close();
        }, 1_000);
        timer.unref();
        idle.push({ connected, timer });
      },
    };
    let phase = lent;
    return {
      async query(text, parameters) {
        try {
          return await connected.query(text, parameters);
        } catch (error) {
          if (phase === lent) phase = broken;
          throw error;
        }
      },
      on: () => undefined,
      close() {
        const ending = phase;
        phase = returned;
        ending.close();
      },
    };
  };
  return {
    async connect(): Promise<SqlServerSession> {
      const entry = idle.pop();
      if (entry !== undefined) {
        clearTimeout(entry.timer);
        return lend(entry.connected);
      }
      const connected = await sqlServerSession(server);
      // A driver can emit `error` after the close, and an `error` with no listener stops the process.
      connected.on('error', () => {});
      open.add(connected);
      return lend(connected);
    },
    close(): void {
      for (const entry of idle.splice(0)) clearTimeout(entry.timer);
      for (const connected of open) connected.close();
      open.clear();
    },
  };
}

/**
 * The store over sessions of its own. A waiter tries each 500 ms, and the key
 * of a killed holder is free 2 s after its last renewal.
 */
const pooledStore = (location: string) => {
  const sessions = sessionsOf(serverAt(location));
  const store = sqlServerStoreOn(() => sessions.connect(), {
    heartbeatInterval: 500,
    leaseDuration: 2_000,
    clock: globalThis,
  });
  return { store, close: () => sessions.close() };
};

/** The store of a child process or a worker thread: its idle sessions close after 1 s, or with the process. */
export const sqlServerStore = (location: string) => pooledStore(location).store;

/** The store of a child process or a worker thread over `location`. */
export const openInProcess = sqlServerStore;

const module: StoreModule = {
  url: new URL(import.meta.url),
  export: 'openInProcess',
};

export const subject: Subject<Host> = {
  name: 'SqlServerStore',
  fixture: sqlServerFixture,
  open: (location) => {
    const { store, close } = pooledStore(location);
    return {
      store,
      async [Symbol.asyncDispose]() {
        close();
      },
    };
  },
  process: { module, admit() {} },
  // A waiter sees a release only at its next try.
  grantLatency: 500,
};

export const sharing = sharesWithProcesses(subject.process);

export const threadSharing = sharesWithThreads<Host>({ module, admit() {} });

export const partitionable: Partitionable = {
  heartbeatInterval: 200,
  async partitionable(location, clock) {
    const server = serverAt(location);
    const proxy = await proxyTo(server);
    return {
      store: sqlServerStoreOn(
        () =>
          sqlServerSession({ ...server, host: proxy.host, port: proxy.port }),
        { heartbeatInterval: this.heartbeatInterval, clock },
      ),
      partition: () => proxy.partition(),
      [Symbol.asyncDispose]: () => proxy[Symbol.asyncDispose](),
    };
  },
};
