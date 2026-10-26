import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Worker } from 'node:worker_threads';

import mariadb, { type Pool } from 'mariadb';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { Connection, Request, TYPES } from 'tedious';

import { Docker } from '@zukhruf/docker';
import { DockerTestbed, TestRun } from '@zukhruf/testing/docker';
import { TemporaryFiles } from '@zukhruf/testing/fs';
import { Mariadb } from '@zukhruf/testing/mariadb';
import { Mysql } from '@zukhruf/testing/mysql';
import { type DatabaseOptions, Postgres } from '@zukhruf/testing/postgres';
import { type Database, SqlServer } from '@zukhruf/testing/sqlserver';

import { DockerEngineStore } from '../lock-stores/docker/docker-engine-store.ts';
import { LockFileStore } from '../lock-stores/file-system/lock-file-store.ts';
import { TicketQueueFileStore } from '../lock-stores/file-system/ticket-queue-file-store.ts';
import { IpcLockCoordinator } from '../lock-stores/ipc/ipc-lock-coordinator.ts';
import { IpcStore } from '../lock-stores/ipc/ipc-store.ts';
import { MariadbStore } from '../lock-stores/mariadb/mariadb-store.ts';
import { MemoryStore } from '../lock-stores/memory/memory-store.ts';
import {
  MysqlStore,
  type MysqlStoreOptions,
} from '../lock-stores/mysql/mysql-store.ts';
import { PostgresStore } from '../lock-stores/postgres/postgres-store.ts';
import { SocketStore } from '../lock-stores/socket/socket-store.ts';
import { SqliteStore } from '../lock-stores/sqlite/sqlite-store.ts';
import {
  type SqlServerSession,
  SqlServerStore,
} from '../lock-stores/sqlserver/sqlserver-store.ts';
import { ThreadLockCoordinator } from '../lock-stores/thread/thread-lock-coordinator.ts';
import { ThreadStore } from '../lock-stores/thread/thread-store.ts';
import type { LockStore } from '../mutex/lock-store.ts';

const pollInterval = 10;

/** How long a waiting caller is given to (wrongly) enter an occupied lock. */
export const settle = pollInterval * 5;

/** A new lock-server leader grants nothing for this long after a failover. */
export const graceWindow = 200;

/**
 * Who can share a store's locks: one store instance, the threads of one
 * process, a parent and the children it spawned, every process on the host, or
 * every process on every machine that reaches one server.
 */
export type Reach =
  'instance' | 'process' | 'process-tree' | 'host' | 'network';

const reachOrder: readonly Reach[] = [
  'instance',
  'process',
  'process-tree',
  'host',
  'network',
];

/**
 * The time limit of a test that makes `grants` grants one after another
 * while other callers wait: twice the `grantLatency` of each grant, and never
 * less than 15 seconds.
 */
export const timeoutForGrants = (store: StoreCase, grants: number): number =>
  Math.max(15_000, grants * store.grantLatency * 2);

/**
 * The deadline of a step that makes `cost.grants` grants and waits for
 * `cost.releases` releases of a closed holder: `limit` for a fast store, plus
 * the `grantLatency` of each grant and the `releaseLatency` of each release.
 */
export const deadlineFor = (
  store: StoreCase,
  limit: number,
  cost: { grants: number; releases: number },
): number =>
  limit +
  cost.grants * store.grantLatency +
  cost.releases * store.releaseLatency;

/** Whether the locks of `store` are shared at least as far as `reach`. */
export const reaches = (store: StoreCase, reach: Reach): boolean =>
  reachOrder.indexOf(store.reach) >= reachOrder.indexOf(reach);

/** The xUnit test fixture of one case: the shared thing that its stores open, found at `location`. */
export interface StoreFixture extends AsyncDisposable {
  location: string;
}

/** A store built in this thread, plus how children and workers started from here join it. */
export interface StoreHost extends AsyncDisposable {
  store: LockStore;
  adoptProcess(child: ChildProcess): void;
  adoptThread(worker: Worker): void;
}

export interface StoreCase {
  name: string;
  reach: Reach;
  /** Whether a new store over the same fixture keeps issuing newer tokens. */
  durableTokens: boolean;
  /** Milliseconds: the upper bound of one grant and its release with no contention, on the local server or engine. */
  grantLatency: number;
  /** Milliseconds: the upper bound from the close of a holder process until a look sees no holder. */
  releaseLatency: number;
  /**
   * Makes a new fixture, which the test disposes. A server-backed fixture
   * finds its Docker engine through `environment`.
   */
  fixture(environment: DatabaseOptions['environment']): Promise<StoreFixture>;
  /** Stores opened over the same fixture location share locks. */
  open(location: string): StoreHost;
  /**
   * Builds the store that a child process started by a host uses. It shares
   * locks with the host only when the reach includes that child.
   */
  openInChild?(location: string): LockStore;
  /** Builds the store inside a worker thread that a host started and adopted. */
  openInThread?(location: string): LockStore;
}

/** A scratch directory as the fixture: its path is the location. */
async function directoryFixture(): Promise<StoreFixture> {
  const directory = await new TemporaryFiles().directory('mutex-test-');
  return {
    location: directory.path,
    [Symbol.asyncDispose]: () => directory[Symbol.asyncDispose](),
  };
}

const isAsyncDisposable = (value: object): value is AsyncDisposable =>
  Symbol.asyncDispose in value &&
  typeof value[Symbol.asyncDispose] === 'function';

/** A store that every participant builds the same way, with nothing to adopt. */
function sharedByDirectory(create: (directory: string) => LockStore) {
  return {
    open: (directory: string): StoreHost => {
      const store = create(directory);
      return {
        store,
        adoptProcess() {},
        adoptThread() {},
        async [Symbol.asyncDispose]() {
          if (isAsyncDisposable(store)) await store[Symbol.asyncDispose]();
        },
      };
    },
    openInChild: create,
    openInThread: create,
  };
}

/** A new database with the token sequence that the app creates before it starts; its connection string is the location. */
async function postgresFixture(
  environment: DatabaseOptions['environment'],
): Promise<StoreFixture> {
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
function postgresStore(pool: pg.Pool) {
  return new PostgresStore({
    connect: () => pool.connect(),
    sequence: 'mutex_tokens',
    heartbeatInterval: 200,
  });
}

const postgresPool = (location: string, allowExitOnIdle: boolean) =>
  new pg.Pool({
    connectionString: location,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    allowExitOnIdle,
  });

/** How a store of a server case reaches its database. The location of the fixture is this object as JSON. */
interface Server {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

const serverOf = ({
  host,
  port,
  user,
  password,
  database,
}: Database): Server => ({
  host,
  port,
  user,
  password,
  database,
});

const serverAt = (location: string): Server => JSON.parse(location);

/**
 * Makes a new database with `prepare`, which creates what the app creates
 * before it starts. The fixture drops the database.
 */
async function serverFixture(
  database: Database,
  prepare: () => Promise<void>,
): Promise<StoreFixture> {
  try {
    await prepare();
  } catch (error) {
    await database.cleanup();
    throw error;
  }
  return {
    location: JSON.stringify(serverOf(database)),
    [Symbol.asyncDispose]: () => database.cleanup(),
  };
}

/** A column of a row that tedious gives with `useColumnNames` off, its default. */
interface Column {
  metadata: { colName: string };
  value: unknown;
}

/** The caller's wrapper that the SqlServerStore page shows: one tedious connection is one session. */
async function sqlServerSession(server: Server): Promise<SqlServerSession> {
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
async function sqlServerFixture(
  environment: DatabaseOptions['environment'],
): Promise<StoreFixture> {
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
const sqlServerStore = (location: string) =>
  new SqlServerStore({
    connect: () => sqlServerSession(serverAt(location)),
    sequence: 'dbo.mutex_tokens',
    heartbeatInterval: 200,
  });

/** A new database with the token table that the app creates before it starts. */
async function mysqlFixture(
  environment: DatabaseOptions['environment'],
): Promise<StoreFixture> {
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

const mysqlStore = (connect: MysqlStoreOptions['connect']) =>
  new MysqlStore({ connect, table: 'mutex_tokens', heartbeatInterval: 200 });

/**
 * A mysql2 pool keeps its process alive until `end()`, and a child or a
 * thread never ends its store. So its store gets one connection per session,
 * and giving the session back closes the connection.
 */
const mysqlStoreThatLetsItsProcessExit = (location: string) =>
  mysqlStore(async () => {
    const connection = await mysql.createConnection(serverAt(location));
    return Object.assign(connection, { release: () => connection.destroy() });
  });

/** A new database with the token sequence that the app creates before it starts. */
async function mariadbFixture(
  environment: DatabaseOptions['environment'],
): Promise<StoreFixture> {
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
const mariadbPool = (location: string, exitOnIdle: boolean) =>
  mariadb.createPool({
    ...serverAt(location),
    keepAliveDelay: 10_000,
    ...(exitOnIdle && { minimumIdle: 0, idleTimeout: 1 }),
  });

const mariadbStore = (pool: Pool) =>
  new MariadbStore({
    connect: () => pool.getConnection(),
    sequence: 'mutex_tokens',
    heartbeatInterval: 200,
  });

const dockerNamespaceLabel = 'zukhruf.mutex.namespace';

/** Where the stores of a Docker engine case meet. The location of the fixture is this object as JSON. */
interface DockerEngineLocation {
  host: string;
  namespace: string;
  /** The labels of the test run, for each claim and rung. */
  labels: Record<string, string>;
  /** The test run, which records each child process of a host. Absent outside a run. */
  run?: { id: string; directory: string };
}

/** The image of each DockerEngineStore container. */
const dockerImage = 'node:lts-alpine';

/**
 * A new namespace on the engine that `environment` selects, with
 * `dockerImage` on it: the store never pulls its image. The location also
 * has the labels and the records of the test run, so the teardown of the run
 * removes what a killed process left. The disposal removes each container and volume with
 * the label of the namespace, through a client of its own, so it runs after
 * each store of the test ended its client.
 */
async function dockerEngineFixture(
  environment: DatabaseOptions['environment'],
): Promise<StoreFixture> {
  const { host } = await (async () => {
    await using docker = await Docker.connect({ environment });
    if (!(await docker.images.inspect(dockerImage))) {
      await docker.images.pull(dockerImage);
    }
    return { host: docker.host };
  })();
  const run = TestRun.fromEnvironment(environment);
  const location: DockerEngineLocation = {
    host,
    namespace: `zukhruf-mutex-test-${randomUUID()}`,
    labels: new DockerTestbed({ environment }).defaults.labels,
    ...(run && { run: { id: run.id, directory: run.directory } }),
  };
  return {
    location: JSON.stringify(location),
    [Symbol.asyncDispose]: async () => {
      await using cleaner = await Docker.connect({ host });
      const filters = {
        label: [`${dockerNamespaceLabel}=${location.namespace}`],
      };
      for (const { Id } of await cleaner.containers.list({
        all: true,
        filters,
      })) {
        await (await cleaner.containers.find(Id))?.remove({ force: true });
      }
      for (const { Name } of await cleaner.volumes.list({ filters })) {
        await (await cleaner.volumes.find(Name))?.remove({ force: true });
      }
    },
  };
}

/**
 * A DockerEngineStore takes a connected client, and `open` is synchronous. So
 * this store connects its own client when it opens, and gives each call to a
 * DockerEngineStore over that client once it is connected. The free sockets
 * of a client do not keep a process running, so a child or a thread that
 * never disposes its client can exit.
 */
function dockerEngineStore(location: string) {
  const { host, namespace, labels }: DockerEngineLocation =
    JSON.parse(location);
  const docker = Docker.connect({ host });
  const store = docker.then(
    (client) =>
      new DockerEngineStore({
        docker: client,
        image: dockerImage,
        namespace,
        heartbeatInterval: 500,
        labels,
      }),
  );
  const lockStore: LockStore = {
    acquire: async (key, options) => (await store).acquire(key, options),
    tryAcquire: async (key) => (await store).tryAcquire(key),
    isHeld: async (key) => (await store).isHeld(key),
  };
  return { docker, store: lockStore };
}

export const storeCases: StoreCase[] = [
  {
    name: 'MemoryStore',
    reach: 'instance',
    durableTokens: false,
    grantLatency: 1,
    releaseLatency: 1,
    fixture: directoryFixture,
    open: () => ({
      store: new MemoryStore(),
      adoptProcess() {},
      adoptThread() {},
      async [Symbol.asyncDispose]() {},
    }),
    openInChild: () => new MemoryStore(),
  },
  {
    name: 'ThreadStore',
    reach: 'process',
    durableTokens: false,
    grantLatency: 1,
    releaseLatency: 10,
    fixture: directoryFixture,
    open: () => {
      const coordinator = new ThreadLockCoordinator();
      return {
        store: coordinator,
        adoptProcess() {},
        adoptThread: (worker) => coordinator.adopt(worker),
        async [Symbol.asyncDispose]() {},
      };
    },
    // In a child process of its own, the child's main thread is the coordinator.
    openInChild: () => new ThreadLockCoordinator(),
    openInThread: () => new ThreadStore(),
  },
  {
    name: 'IpcStore',
    reach: 'process-tree',
    durableTokens: false,
    grantLatency: 1,
    releaseLatency: 10,
    fixture: directoryFixture,
    open: () => {
      const coordinator = new IpcLockCoordinator();
      return {
        store: coordinator,
        adoptProcess: (child) => coordinator.adopt(child),
        adoptThread() {},
        async [Symbol.asyncDispose]() {},
      };
    },
    openInChild: () => new IpcStore(),
  },
  {
    name: 'TicketQueueFileStore',
    reach: 'host',
    durableTokens: true,
    grantLatency: 20,
    releaseLatency: 10,
    fixture: directoryFixture,
    ...sharedByDirectory(
      (directory) => new TicketQueueFileStore(directory, { pollInterval }),
    ),
  },
  {
    name: 'LockFileStore',
    reach: 'host',
    durableTokens: true,
    grantLatency: 20,
    releaseLatency: 10,
    fixture: directoryFixture,
    ...sharedByDirectory(
      (directory) => new LockFileStore(directory, { pollInterval }),
    ),
  },
  {
    name: 'SqliteStore',
    reach: 'host',
    durableTokens: true,
    grantLatency: 20,
    releaseLatency: 10,
    fixture: directoryFixture,
    ...sharedByDirectory(
      (directory) => new SqliteStore(directory, { pollInterval }),
    ),
  },
  {
    name: 'SocketStore',
    reach: 'host',
    durableTokens: true,
    grantLatency: 20,
    releaseLatency: 10,
    fixture: directoryFixture,
    ...sharedByDirectory(
      (directory) => new SocketStore(directory, { pollInterval, graceWindow }),
    ),
  },
  {
    name: 'PostgresStore',
    reach: 'network',
    durableTokens: true,
    grantLatency: 10,
    releaseLatency: 10,
    fixture: postgresFixture,
    open: (location) => {
      const pool = postgresPool(location, false);
      return {
        store: postgresStore(pool),
        adoptProcess() {},
        adoptThread() {},
        [Symbol.asyncDispose]: () => pool.end(),
      };
    },
    openInChild: (location) => postgresStore(postgresPool(location, true)),
    openInThread: (location) => postgresStore(postgresPool(location, true)),
  },
  {
    name: 'SqlServerStore',
    reach: 'network',
    durableTokens: true,
    grantLatency: 20,
    releaseLatency: 20,
    fixture: sqlServerFixture,
    open: (location) => ({
      store: sqlServerStore(location),
      adoptProcess() {},
      adoptThread() {},
      async [Symbol.asyncDispose]() {},
    }),
    openInChild: sqlServerStore,
    openInThread: sqlServerStore,
  },
  {
    name: 'MysqlStore',
    reach: 'network',
    durableTokens: true,
    grantLatency: 10,
    releaseLatency: 20,
    fixture: mysqlFixture,
    open: (location) => {
      const pool = mysql.createPool({
        ...serverAt(location),
        enableKeepAlive: true,
        keepAliveInitialDelay: 10_000,
      });
      return {
        store: mysqlStore(() => pool.getConnection()),
        adoptProcess() {},
        adoptThread() {},
        [Symbol.asyncDispose]: () => pool.end(),
      };
    },
    openInChild: mysqlStoreThatLetsItsProcessExit,
    openInThread: mysqlStoreThatLetsItsProcessExit,
  },
  {
    name: 'MariadbStore',
    reach: 'network',
    durableTokens: true,
    grantLatency: 10,
    releaseLatency: 10,
    fixture: mariadbFixture,
    open: (location) => {
      const pool = mariadbPool(location, false);
      return {
        store: mariadbStore(pool),
        adoptProcess() {},
        adoptThread() {},
        [Symbol.asyncDispose]: () => pool.end(),
      };
    },
    openInChild: (location) => mariadbStore(mariadbPool(location, true)),
    openInThread: (location) => mariadbStore(mariadbPool(location, true)),
  },
  {
    name: 'DockerEngineStore',
    reach: 'network',
    durableTokens: true,
    grantLatency: 300,
    releaseLatency: 150,
    fixture: dockerEngineFixture,
    open: (location) => {
      const { docker, store } = dockerEngineStore(location);
      const { run }: DockerEngineLocation = JSON.parse(location);
      const records: Promise<void>[] = [];
      return {
        store,
        // A child that outlives a killed test process can still grant. Its
        // process record keeps the run's records until it ends, so the
        // recovery of a later run removes what it created after the teardown.
        adoptProcess(child) {
          const { pid } = child;
          if (!run || pid === undefined) return;
          const exited = Promise.withResolvers<void>();
          child.once('exit', () => exited.resolve());
          const record = (async () => {
            await using _record = await new TestRun(
              run.id,
              run.directory,
            ).recordProcess(pid);
            await exited.promise;
          })();
          // The disposal awaits it and reports a failed write.
          record.catch(() => {});
          records.push(record);
        },
        adoptThread() {},
        [Symbol.asyncDispose]: async () => {
          try {
            await Promise.all(records);
          } finally {
            await (await docker)[Symbol.asyncDispose]();
          }
        },
      };
    },
    openInChild: (location) => dockerEngineStore(location).store,
    openInThread: (location) => dockerEngineStore(location).store,
  },
];

function storeCase(name: string): StoreCase {
  const store = storeCases.find((candidate) => candidate.name === name);
  if (!store) throw new Error(`Unknown store ${JSON.stringify(name)}`);
  return store;
}

/** For child processes that a host started and adopted. */
export function createChildStore(name: string, location: string): LockStore {
  const openInChild = storeCase(name).openInChild;
  if (!openInChild)
    throw new Error(`${name} cannot be shared with child processes`);
  return openInChild(location);
}

/** For worker threads that a host started and adopted. */
export function createThreadStore(name: string, location: string): LockStore {
  const openInThread = storeCase(name).openInThread;
  if (!openInThread)
    throw new Error(`${name} cannot be shared with worker threads`);
  return openInThread(location);
}
