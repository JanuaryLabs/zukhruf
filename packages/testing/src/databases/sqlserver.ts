import { once } from 'node:events';

import sql from 'mssql';

import { retryUntilReady } from '../async/retry-until-ready.ts';
import { readRun } from '../docker/run-records.ts';
import type { ServiceContainer } from '../docker/service-container.ts';
import { DockerTestbed } from '../docker/testbed.ts';
import { KIND_LABEL, databaseName, dropDatabase } from './collector.ts';
import type { Database, DatabaseOptions } from './database.ts';
import { type OwnedPool, OwnedPools } from './owned-pools.ts';
import {
  type SqlServerServer,
  connectionString,
  sqlserver,
} from './sqlserver-collector.ts';

export type { Database, DatabaseOptions } from './database.ts';

export const SQL_SERVER_FULL_IMAGE =
  'mcr.microsoft.com/mssql/server:2022-latest';

/**
 * The options of a pool of a handle: the handle names the database and the
 * user. The options name the rest, also the server and the port, so a test
 * can route a pool through a proxy.
 */
export type SqlServerPoolOptions = Omit<
  sql.config,
  | 'server'
  | 'database'
  | 'user'
  | 'password'
  | 'domain'
  | 'authentication'
  | 'options'
> & {
  server?: string;
  options?: Omit<sql.IOptions, 'database'>;
};

/** A handle of a SQL Server database that owns the pools it gives. */
export interface SqlServerDatabase extends Database {
  /**
   * A connected pool of this database; the disposal of the handle closes it
   * before the drop. It resolves once the pool is connected: mssql makes the
   * tarn pool, whose events the disposal reads, only in `connect()`.
   */
  pool(options?: SqlServerPoolOptions): Promise<sql.ConnectionPool>;
}

/** A tedious connection of a pool, as tarn gives it. */
type PoolConnection = Parameters<sql.ConnectionPool['pool']['release']>[0];

/**
 * Closes the pool fully, and resolves with the number of connections that it
 * closed while they were checked out. `close()` resolves once each idle
 * connection's socket has closed (tedious `end`), but it waits for a
 * checked-out connection with no limit; so each of those is closed first and
 * given back to tarn. tarn counts a connection as used while mssql validates
 * it, and reports it (`acquireSuccess`) only after that, so a connection that
 * tarn gives out during the disposal is closed when tarn reports it.
 * `close()` can run again after the test closed the pool: it joins a close
 * that is running, and resolves at once after one.
 */
function owned(config: sql.config): OwnedPool<Promise<sql.ConnectionPool>> {
  const pool = new sql.ConnectionPool(config);
  const ending = new AbortController();
  const checkedOut = new Set<PoolConnection>();
  const forced: Promise<void>[] = [];
  const forceClose = (
    tarn: sql.ConnectionPool['pool'],
    connection: PoolConnection,
  ) =>
    forced.push(
      (async () => {
        // tedious emits `end` once, when it closes the connection.
        if (!connection.closed) {
          const ended = once(connection, 'end');
          connection.close();
          await ended;
        }
        tarn.release(connection);
      })(),
    );
  const connected = pool.connect().then(() => {
    const tarn = pool.pool;
    tarn.on('acquireSuccess', (_id, connection) => {
      if (ending.signal.aborted) forceClose(tarn, connection);
      else checkedOut.add(connection);
    });
    tarn.on('release', (connection) => checkedOut.delete(connection));
    return tarn;
  });
  return {
    pool: connected.then(() => pool),
    async end() {
      const tarn = await connected.catch(() => undefined);
      // A pool that did not connect has no connection to close.
      if (tarn === undefined) return 0;
      ending.abort();
      for (const connection of [...checkedOut]) forceClose(tarn, connection);
      await pool.close();
      await Promise.all(forced);
      return forced.length;
    },
  };
}

/**
 * SQL Server test configuration. The full image is the default on every
 * engine, emulated on arm64: Microsoft builds it only for amd64, and it holds
 * the `sqlcmd` that an exec needs.
 */
export class SqlServer {
  readonly #docker: DockerTestbed;
  readonly #runId: string | undefined;
  readonly #options;

  constructor({
    environment,
    image = SQL_SERVER_FULL_IMAGE,
    password = 'StrongP@ssw0rd123!',
    database = 'testdb',
    labels,
  }: DatabaseOptions) {
    this.#docker = new DockerTestbed({ environment });
    this.#runId = readRun(environment)?.id;
    this.#options = { image, password, database, labels };
  }

  /** Create an isolated database on the persistent shared server. */
  async database(): Promise<SqlServerDatabase> {
    const { image } = this.#options;
    const container = await this.#acquire(image, 'reuse');
    const database = databaseName(this.#runId);
    try {
      await this.#createDatabase(container, database);
      return this.#handle(container, image, database, async () => {
        try {
          await dropDatabase(
            sqlserver,
            container.container,
            this.#options.password,
            database,
          );
        } finally {
          await container.disconnect();
        }
      });
    } catch (error) {
      await container.disconnect();
      throw error;
    }
  }

  /** Start a dedicated server; the returned handle owns its container. */
  async start(): Promise<SqlServerDatabase> {
    const { image, database } = this.#options;
    const container = await this.#acquire(image, 'serve');
    try {
      await this.#createDatabase(container, database);
      return this.#handle(container, image, database, () =>
        container.cleanup(),
      );
    } catch (error) {
      await container.cleanup();
      throw error;
    }
  }

  #server({ host, port }: ServiceContainer): SqlServerServer {
    return { host, port, password: this.#options.password };
  }

  #connectionString(container: ServiceContainer, database: string): string {
    return connectionString(this.#server(container), database);
  }

  async #ping(container: ServiceContainer): Promise<void> {
    const pool = new sql.ConnectionPool(
      `${this.#connectionString(container, 'master')}connectionTimeout=1000;requestTimeout=1000;`,
    );
    try {
      await pool.connect();
      await pool.request().query('SELECT 1');
    } finally {
      await pool.close();
    }
  }

  async #createDatabase(
    container: ServiceContainer,
    database: string,
  ): Promise<void> {
    const pool = new sql.ConnectionPool(
      this.#connectionString(container, 'master'),
    );
    await pool.connect();
    try {
      await pool
        .request()
        .query(
          `IF NOT EXISTS (SELECT * FROM sys.databases WHERE name = '${database}') CREATE DATABASE [${database}]`,
        );
    } finally {
      await pool.close();
    }
  }

  #acquire(image: string, mode: 'serve' | 'reuse'): Promise<ServiceContainer> {
    const { password, labels } = this.#options;
    return this.#docker[mode](
      {
        Image: image,
        Labels: { ...labels, [KIND_LABEL]: sqlserver.kind },
        Env: [
          'ACCEPT_EULA=Y',
          `MSSQL_SA_PASSWORD=${password}`,
          'MSSQL_MEMORY_LIMIT_MB=2048',
          'MSSQL_PID=Express',
        ],
        HostConfig: {
          Tmpfs: { '/var/opt/mssql': 'rw,size=2g,mode=1777' },
          Memory: 3 * 1024 ** 3,
          MemorySwappiness: 0,
        },
      },
      {
        internalPort: 1433,
        healthy: (container, signal) =>
          retryUntilReady(() => this.#ping(container), {
            maxRetryTime: 180_000,
            signal,
          }),
      },
    );
  }

  #handle(
    container: ServiceContainer,
    image: string,
    database: string,
    release: () => Promise<void>,
  ): SqlServerDatabase {
    const { password } = this.#options;
    const { host, port } = container;
    const user = 'sa';
    const pools = new OwnedPools<Promise<sql.ConnectionPool>>('connection');
    const cleanup = () => pools.dispose(release);
    return {
      connectionString: this.#connectionString(container, database),
      image,
      user,
      password,
      database,
      containerId: container.container.id,
      host,
      port,
      // async: once the disposal started, the promise rejects.
      pool: async (options) =>
        pools.add(() =>
          owned({
            server: host,
            port,
            ...options,
            options: {
              encrypt: false,
              trustServerCertificate: true,
              ...options?.options,
              database,
            },
            database,
            user,
            password,
          }),
        ),
      cleanup,
      [Symbol.asyncDispose]: cleanup,
    };
  }
}
