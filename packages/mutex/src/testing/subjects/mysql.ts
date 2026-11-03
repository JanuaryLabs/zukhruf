import assert from 'node:assert/strict';

import mysql from 'mysql2/promise';

import type { Clock } from '@zukhruf/async';
import { Mysql } from '@zukhruf/testing/mysql';
import type { DatabaseOptions } from '@zukhruf/testing/postgres';

import {
  type MysqlSession,
  MysqlStore,
  type MysqlStoreOptions,
} from '../../lock-stores/mysql/mysql-store.ts';
import type {
  Partitionable,
  PoolControl,
  SessionControl,
} from '../contract/sessions.ts';
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

/** A new database with the token table that the app creates before it starts. */
export async function mysqlFixture(
  environment: DatabaseOptions['environment'],
): Promise<Fixture> {
  const database = await new Mysql({ environment }).database();
  return serverFixture(database, async () => {
    const owner = await mysql.createConnection(database.connectionString);
    try {
      await owner.query(
        'CREATE TABLE mutex_tokens (id BIGINT UNSIGNED NOT NULL)',
      );
      await owner.query('INSERT INTO mutex_tokens VALUES (0)');
    } finally {
      await owner.end();
    }
  });
}

export const mysqlStore = (connect: MysqlStoreOptions['connect']) =>
  new MysqlStore({
    connect,
    table: 'mutex_tokens',
    heartbeatInterval: 200,
    clock: globalThis,
  });

/**
 * A mysql2 pool keeps its process alive until `end()`, and a child or a
 * thread never ends its store. So its store gets one connection per session,
 * and giving the session back closes the connection.
 */
export const mysqlStoreThatLetsItsProcessExit = (location: string) =>
  mysqlStore(async () => {
    const connection = await mysql.createConnection(serverAt(location));
    return Object.assign(connection, { release: () => connection.destroy() });
  });

/** The store of a child process or a worker thread over `location`. */
export const openInProcess = mysqlStoreThatLetsItsProcessExit;

const module: StoreModule = {
  url: new URL(import.meta.url),
  export: 'openInProcess',
};

export const subject: Subject<Host> = {
  name: 'MysqlStore',
  fixture: mysqlFixture,
  open: (location) => {
    const pool = mysql.createPool({
      ...serverAt(location),
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000,
    });
    return {
      store: mysqlStore(() => pool.getConnection()),
      [Symbol.asyncDispose]: () => pool.end(),
    };
  },
  process: { module, admit() {} },
  grantLatency: 10,
  releaseLatency: 20,
};

export const sharing = sharesWithProcesses(subject.process);

export const threadSharing = sharesWithThreads<Host>({ module, admit() {} });

const poolTo = (server: Server, options: mysql.PoolOptions = {}) =>
  mysql.createPool({ ...server, ...options });

const storeOn = (
  connect: MysqlStoreOptions['connect'],
  heartbeatInterval: number,
  clock: Clock,
) =>
  new MysqlStore({ connect, table: 'mutex_tokens', heartbeatInterval, clock });

export const partitionable: Partitionable = {
  heartbeatInterval: 200,
  async partitionable(location, clock) {
    const server = serverAt(location);
    const proxy = await proxyTo(server);
    const pool = poolTo(server, { host: proxy.host, port: proxy.port });
    const stack = new AsyncDisposableStack();
    stack.defer(() => pool.end());
    // Closed first: the closed sockets end the sessions, so the pool can end.
    stack.use(proxy);
    return {
      store: storeOn(() => pool.getConnection(), this.heartbeatInterval, clock),
      partition: () => proxy.partition(),
      [Symbol.asyncDispose]: () => stack.disposeAsync(),
    };
  },
};

/**
 * A session that connects again by itself when the server ends its
 * connection, and tells the store nothing: no `error`, no `end`. The store's
 * listeners hear nothing. A query that fails on the ended connection runs
 * again on the new one. `reconnected` resolves once the new connection is up.
 * Queries on the new connection wait until `resume()`, so the test
 * decides when the store sees it.
 */
async function silentlyReconnectingSession(server: Server) {
  const open = async () => {
    const connection = await mysql.createConnection(server);
    connection.on('error', () => {});
    return connection;
  };
  let current = await open();
  const id = current.threadId;
  const reconnected = Promise.withResolvers<void>();
  const resumed = Promise.withResolvers<void>();
  let reconnectedYet = false;
  current.once('end', () => {
    open().then((next) => {
      current = next;
      reconnectedYet = true;
      reconnected.resolve();
    }, reconnected.reject);
  });
  const session: MysqlSession = {
    query: async (sql, values) => {
      try {
        if (!reconnectedYet) return await current.query(sql, values);
      } catch {
        await reconnected.promise;
      }
      await resumed.promise;
      return current.query(sql, values);
    },
    on: () => session,
    off: () => session,
    release: () => current.destroy(),
    destroy: () => current.destroy(),
  };
  return {
    session,
    id,
    reconnected: reconnected.promise,
    resume: () => resumed.resolve(),
  };
}

export const sessionControl: SessionControl = {
  async watched(location, heartbeatInterval) {
    const server = serverAt(location);
    const pool = poolTo(server);
    const sessions: mysql.PoolConnection[] = [];
    const admin = await mysql.createConnection(server);
    return {
      store: storeOn(
        async () => {
          const session = await pool.getConnection();
          sessions.push(session);
          return session;
        },
        heartbeatInterval,
        globalThis,
      ),
      async killHolder() {
        const [holder] = sessions;
        assert.ok(holder, 'The store must hold a session');
        await admin.query(`KILL ${holder.threadId}`);
      },
      async [Symbol.asyncDispose]() {
        await admin.end();
        await pool.end();
      },
    };
  },
  async silentlyReconnecting(location, heartbeatInterval) {
    const server = serverAt(location);
    const reconnecting = await silentlyReconnectingSession(server);
    const admin = await mysql.createConnection(server);
    return {
      store: storeOn(
        async () => reconnecting.session,
        heartbeatInterval,
        globalThis,
      ),
      async kill() {
        await admin.query(`KILL ${reconnecting.id}`);
      },
      reconnected: reconnecting.reconnected,
      resume: reconnecting.resume,
      async [Symbol.asyncDispose]() {
        reconnecting.resume();
        await admin.end();
      },
    };
  },
  async untilASessionWaits(t, location) {
    const observer = await mysql.createConnection(serverAt(location));
    try {
      await t.waitFor(
        async () => {
          const [rows] = await observer.query<mysql.RowDataPacket[]>(
            `SELECT COUNT(*) AS waiting FROM information_schema.PROCESSLIST
             WHERE DB = DATABASE() AND STATE = 'User lock'`,
          );
          assert.ok(
            Number(rows[0]?.['waiting']) > 0,
            'No session waits for a lock.',
          );
        },
        { interval: 10, timeout: 10_000 },
      );
    } finally {
      await observer.end();
    }
  },
};

export const poolControl: PoolControl = {
  pooled(location, size) {
    const pool = poolTo(serverAt(location), { connectionLimit: size });
    return {
      store: storeOn(() => pool.getConnection(), 200, globalThis),
      async nextBorrowerHoldsALock() {
        const borrower = await pool.getConnection();
        try {
          const [rows] = await borrower.query<mysql.RowDataPacket[]>(
            'SELECT RELEASE_ALL_LOCKS() AS locks',
          );
          return Number(rows[0]?.['locks']) > 0;
        } finally {
          borrower.release();
        }
      },
      [Symbol.asyncDispose]: () => pool.end(),
    };
  },
};
