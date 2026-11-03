import assert from 'node:assert/strict';

import mariadb, { type Pool, type PoolConnection } from 'mariadb';

import type { Clock } from '@zukhruf/async';
import { Mariadb } from '@zukhruf/testing/mariadb';
import type { DatabaseOptions } from '@zukhruf/testing/postgres';

import {
  type MariadbSession,
  MariadbStore,
} from '../../lock-stores/mariadb/mariadb-store.ts';
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
import { type Server, serverAt, serverFixture, serverOf } from './server.ts';

/** A new database with the token sequence that the app creates before it starts. */
export async function mariadbFixture(
  environment: DatabaseOptions['environment'],
): Promise<Fixture> {
  const database = await new Mariadb({ environment }).database();
  return serverFixture(database, async () => {
    const owner = await mariadb.createConnection(serverOf(database));
    try {
      await owner.query('CREATE SEQUENCE mutex_tokens');
    } finally {
      await owner.end();
    }
  });
}

/**
 * A store over a pool that is configured as the MariadbStore page tells an
 * app to. A child or a thread never ends its pool, so its pool closes each
 * idle connection after one second and keeps none, which lets it exit.
 */
export const mariadbPool = (location: string, exitOnIdle: boolean) =>
  mariadb.createPool({
    ...serverAt(location),
    keepAliveDelay: 10_000,
    ...(exitOnIdle && { minimumIdle: 0, idleTimeout: 1 }),
  });

export const mariadbStore = (pool: Pool) =>
  new MariadbStore({
    connect: () => pool.getConnection(),
    sequence: 'mutex_tokens',
    heartbeatInterval: 200,
    clock: globalThis,
  });

/** The store of a child process or a worker thread over `location`: its pool keeps no idle connection, so the process can exit. */
export const openInProcess = (location: string) =>
  mariadbStore(mariadbPool(location, true));

const module: StoreModule = {
  url: new URL(import.meta.url),
  export: 'openInProcess',
};

export const subject: Subject<Host> = {
  name: 'MariadbStore',
  fixture: mariadbFixture,
  open: (location) => {
    const pool = mariadbPool(location, false);
    return {
      store: mariadbStore(pool),
      [Symbol.asyncDispose]: () => pool.end(),
    };
  },
  process: { module, admit() {} },
  grantLatency: 10,
  releaseLatency: 10,
};

export const sharing = sharesWithProcesses(subject.process);

export const threadSharing = sharesWithThreads<Host>({ module, admit() {} });

const storeOn = (
  connect: () => Promise<MariadbSession>,
  heartbeatInterval: number,
  clock: Clock,
) =>
  new MariadbStore({
    connect,
    sequence: 'mutex_tokens',
    heartbeatInterval,
    clock,
  });

export const partitionable: Partitionable = {
  heartbeatInterval: 200,
  async partitionable(location, clock) {
    const server = serverAt(location);
    const proxy = await proxyTo(server);
    const pool = mariadb.createPool({
      ...server,
      host: proxy.host,
      port: proxy.port,
    });
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
    const connection = await mariadb.createConnection(server);
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
  const session: MariadbSession = {
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
    release: async () => current.destroy(),
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
    const pool = mariadb.createPool(server);
    const sessions: PoolConnection[] = [];
    const admin = await mariadb.createConnection(server);
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
    const admin = await mariadb.createConnection(server);
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
    const observer = await mariadb.createConnection(serverAt(location));
    try {
      await t.waitFor(
        async () => {
          const rows = await observer.query<{ waiting: bigint }[]>(
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
    const pool = mariadb.createPool({
      ...serverAt(location),
      connectionLimit: size,
    });
    return {
      store: storeOn(() => pool.getConnection(), 200, globalThis),
      async nextBorrowerHoldsALock() {
        const borrower = await pool.getConnection();
        try {
          const rows = await borrower.query<{ locks: number }[]>(
            'SELECT RELEASE_ALL_LOCKS() AS locks',
          );
          return Number(rows[0]?.['locks']) > 0;
        } finally {
          await borrower.release();
        }
      },
      [Symbol.asyncDispose]: () => pool.end(),
    };
  },
};
