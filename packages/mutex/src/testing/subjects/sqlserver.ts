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

/**
 * The store gets a new connection for each statement and closes each one, so
 * nothing is left to end. A waiter tries each 500 ms, and the key of a killed
 * holder is free 2 s after its last renewal.
 */
export const sqlServerStore = (location: string) =>
  sqlServerStoreOn(() => sqlServerSession(serverAt(location)), {
    heartbeatInterval: 500,
    leaseDuration: 2_000,
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
