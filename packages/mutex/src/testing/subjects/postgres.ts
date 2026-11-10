import assert from 'node:assert/strict';

import pg from 'pg';

import type { Clock } from '@zukhruf/async';
import { type DatabaseOptions, Postgres } from '@zukhruf/testing/postgres';

import {
  type PostgresSession,
  PostgresStore,
} from '../../lock-stores/postgres/postgres-store.ts';
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

/** A new database with the token sequence that the app creates before it starts; its connection string is the location. */
export async function postgresFixture(
  environment: DatabaseOptions['environment'],
): Promise<Fixture> {
  const database = await new Postgres({ environment }).database();
  try {
    const owner = new pg.Client({
      connectionString: database.connectionString,
    });
    await owner.connect();
    try {
      await owner.query('CREATE SEQUENCE mutex_tokens AS bigint CACHE 1');
    } finally {
      await owner.end();
    }
  } catch (error) {
    await database.cleanup();
    throw error;
  }
  return {
    location: database.connectionString,
    [Symbol.asyncDispose]: () => database.cleanup(),
  };
}

/**
 * A store over a pool that is configured as the PostgresStore page tells an
 * app to. A child or a thread never ends its pool, so its pool lets it exit
 * once its sessions are idle.
 */
export function postgresStore(pool: Pick<pg.Pool, 'connect'>) {
  return new PostgresStore({
    connect: () => pool.connect(),
    sequence: 'mutex_tokens',
    heartbeatInterval: 5_000,
    clock: globalThis,
  });
}

export const postgresPoolConfig = (
  location: string,
  allowExitOnIdle: boolean,
): pg.PoolConfig => ({
  connectionString: location,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  allowExitOnIdle,
});

/**
 * A pool whose disposal resolves once the server has no session of it, and
 * whose type has no `end`, so the disposal is the only way to end it.
 * `pool.end()` resolves before the sockets of its clients close, so a
 * `DROP DATABASE … WITH (FORCE)` right after it can end a session the pool
 * still owns, and the pool's unhandled 'error' fails the running test (#3305).
 * A pool emits 'remove' when the socket of a client has closed, and the
 * server's backend has left by then.
 */
export function postgresPool(config: pg.PoolConfig): AsyncDisposable & {
  pool: Pick<pg.Pool, 'connect'>;
} {
  const pool = new pg.Pool(config);
  const sessions = new Set<pg.PoolClient>();
  pool.on('connect', (client) => sessions.add(client));
  pool.on('remove', (client) => sessions.delete(client));
  return {
    pool,
    [Symbol.asyncDispose]: async () => {
      // No client connects once pool.end() resolves.
      await pool.end();
      while (sessions.size > 0) {
        await new Promise((removed) => pool.once('remove', removed));
      }
    },
  };
}

/** The store of a child process or a worker thread over `location`. */
export const openInProcess = (location: string) =>
  postgresStore(new pg.Pool(postgresPoolConfig(location, true)));

const module: StoreModule = {
  url: new URL(import.meta.url),
  export: 'openInProcess',
};

export const subject: Subject<Host> = {
  name: 'PostgresStore',
  fixture: postgresFixture,
  open: (location) => {
    const host = postgresPool(postgresPoolConfig(location, false));
    return {
      store: postgresStore(host.pool),
      [Symbol.asyncDispose]: () => host[Symbol.asyncDispose](),
    };
  },
  process: { module, admit() {} },
  grantLatency: 10,
};

export const sharing = sharesWithProcesses(subject.process);

export const threadSharing = sharesWithThreads<Host>({ module, admit() {} });

const storeOn = (
  pool: Pick<pg.Pool, 'connect'>,
  heartbeatInterval: number,
  clock: Clock,
) =>
  new PostgresStore({
    connect: () => pool.connect(),
    sequence: 'mutex_tokens',
    heartbeatInterval,
    clock,
  });

async function adminOf(location: string) {
  const admin = new pg.Client({ connectionString: location });
  await admin.connect();
  return admin;
}

export const partitionable: Partitionable = {
  heartbeatInterval: 200,
  async partitionable(location, clock) {
    const target = new URL(location);
    const proxy = await proxyTo({
      host: target.hostname,
      port: Number(target.port),
    });
    const proxied = new URL(location);
    proxied.hostname = proxy.host;
    proxied.port = String(proxy.port);
    const stack = new AsyncDisposableStack();
    const host = stack.use(
      postgresPool({ connectionString: proxied.toString() }),
    );
    // Closed first: the closed sockets end a release that waits for an answer, so the pool can end.
    stack.use(proxy);
    return {
      store: storeOn(host.pool, this.heartbeatInterval, clock),
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
async function silentlyReconnectingSession(connectionString: string) {
  const open = async () => {
    const client = new pg.Client({ connectionString });
    client.on('error', () => {});
    await client.connect();
    return client;
  };
  let current = await open();
  const { rows } = await current.query('SELECT pg_backend_pid() AS pid');
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
  const session: PostgresSession = {
    query: async (text, values) => {
      try {
        if (!reconnectedYet) return await current.query(text, values);
      } catch {
        await reconnected.promise;
      }
      await resumed.promise;
      return current.query(text, values);
    },
    on: () => session,
    off: () => session,
    release: () => void current.end(),
  };
  return {
    session,
    pid: Number(rows[0].pid),
    reconnected: reconnected.promise,
    resume: () => resumed.resolve(),
  };
}

export const sessionControl: SessionControl = {
  async watched(location, heartbeatInterval) {
    const host = postgresPool({ connectionString: location });
    const admin = await adminOf(location);
    return {
      store: storeOn(host.pool, heartbeatInterval, globalThis),
      async killHolder() {
        await admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_locks
           WHERE locktype = 'advisory' AND granted
             AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        );
      },
      async [Symbol.asyncDispose]() {
        await admin.end();
        await host[Symbol.asyncDispose]();
      },
    };
  },
  async silentlyReconnecting(location, heartbeatInterval) {
    const reconnecting = await silentlyReconnectingSession(location);
    const admin = await adminOf(location);
    return {
      store: new PostgresStore({
        connect: async () => reconnecting.session,
        sequence: 'mutex_tokens',
        heartbeatInterval,
        clock: globalThis,
      }),
      async kill() {
        await admin.query('SELECT pg_terminate_backend($1)', [
          reconnecting.pid,
        ]);
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
    const observer = await adminOf(location);
    try {
      await t.waitFor(
        async () => {
          const { rows } = await observer.query(
            `SELECT count(*)::int AS waiting FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'`,
          );
          assert.ok(rows[0].waiting > 0, 'No session waits for a lock.');
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
    const host = postgresPool({ connectionString: location, max: size });
    return {
      store: storeOn(host.pool, 200, globalThis),
      async nextBorrowerHoldsALock() {
        const borrower = await host.pool.connect();
        try {
          const { rows } = await borrower.query(
            `SELECT count(*)::int AS locks FROM pg_locks
             WHERE locktype = 'advisory' AND pid = pg_backend_pid()`,
          );
          return rows[0].locks > 0;
        } finally {
          borrower.release();
        }
      },
      [Symbol.asyncDispose]: () => host[Symbol.asyncDispose](),
    };
  },
};
