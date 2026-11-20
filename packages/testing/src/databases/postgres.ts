import pg from 'pg';

import { retryUntilReady } from '../async/retry-until-ready.ts';
import { readRun } from '../docker/run-records.ts';
import type { ServiceContainer } from '../docker/service-container.ts';
import { DockerTestbed } from '../docker/testbed.ts';
import { KIND_LABEL, databaseName, dropDatabase } from './collector.ts';
import type { Database, DatabaseOptions } from './database.ts';
import { type OwnedPool, OwnedPools, disposablePool } from './owned-pools.ts';
import { postgres } from './postgres-collector.ts';
import { succeeded } from './succeeded.ts';

export type { Database, DatabaseOptions } from './database.ts';

/** The size of the tmpfs that holds the data directory, its WAL included. */
const DISK_MB = 512;

/**
 * WAL may take a quarter of the disk, so the databases keep the rest. The
 * 1 GB default is twice the disk: a load filled it before a checkpoint (#4940).
 * max_wal_size "is never a hard limit", so the rest is also its headroom; no
 * archiving, slot or wal_keep_size (default 0) keeps WAL past it, and the
 * min_wal_size default of 80 MB is under it
 * (https://www.postgresql.org/docs/current/wal-configuration.html).
 */
const MAX_WAL_MB = DISK_MB / 4;

export interface PostgresOptions extends DatabaseOptions {
  user?: string;
}

/** The options of a pool of a handle: the handle names the database and the user. */
export type PostgresPoolOptions = Omit<
  pg.PoolConfig,
  'connectionString' | 'database' | 'user' | 'password'
>;

/** A handle of a Postgres database that owns the pools it gives. */
export interface PostgresDatabase extends Database {
  /** A pool of this database; the disposal of the handle ends it before the drop. */
  pool(options?: PostgresPoolOptions): pg.Pool;
}

/**
 * Ends `pool` fully and resolves with the number of clients that were still
 * checked out. `pool.end()` resolves before the sockets of its clients close
 * (#3305); a pool sends 'remove' once a client's socket has closed.
 */
function owned(config: pg.PoolConfig): OwnedPool<pg.Pool> {
  const pool = new pg.Pool(config);
  const open = new Set<pg.PoolClient>();
  const checkedOut = new Set<pg.PoolClient>();
  pool.on('connect', (client) => open.add(client));
  pool.on('remove', (client) => open.delete(client));
  pool.on('acquire', (client) => checkedOut.add(client));
  pool.on('release', (_error, client) => checkedOut.delete(client));
  return {
    pool,
    async end() {
      const ended = pool.ending ? undefined : pool.end();
      const leaked = [...checkedOut];
      for (const client of leaked)
        client.release(new Error('The disposal of its pool destroyed it.'));
      await ended;
      while (open.size > 0)
        await new Promise((removed) => pool.once('remove', removed));
      return leaked.length;
    },
  };
}

/**
 * A pool for a test that has no handle, such as a pool of another role. Its
 * disposal resolves once each client of the pool has closed, and rejects when
 * it destroyed a client that was still checked out.
 */
export function postgresPool(
  config: pg.PoolConfig,
): AsyncDisposable & { readonly pool: pg.Pool } {
  return disposablePool(owned(config), 'client');
}

/** PostgreSQL test configuration. Each acquisition returns an independent handle. */
export class Postgres {
  readonly #docker: DockerTestbed;
  readonly #runId: string | undefined;
  readonly #options;

  constructor({
    environment,
    image = 'postgres:18-alpine',
    password = 'testpassword',
    database = 'testdb',
    user = 'postgres',
    labels,
  }: PostgresOptions) {
    this.#docker = new DockerTestbed({ environment });
    this.#runId = readRun(environment)?.id;
    this.#options = { image, password, database, user, labels };
  }

  /** Create an isolated database on the persistent shared server. */
  async database(): Promise<PostgresDatabase> {
    const container = await this.#acquire('postgres', 'reuse');
    const database = databaseName(this.#runId);
    try {
      await this.#sql(container, `CREATE DATABASE ${database}`);
    } catch (error) {
      await container.disconnect();
      throw error;
    }
    return this.#handle(container, database, async () => {
      await dropDatabase(
        postgres,
        container.container,
        this.#options.user,
        database,
      );
      await container.disconnect();
    });
  }

  /** Start a dedicated server; the returned handle owns its container. */
  async start(): Promise<PostgresDatabase> {
    const { database } = this.#options;
    const container = await this.#acquire(database, 'serve');
    return this.#handle(container, database, () => container.cleanup());
  }

  #sql(container: ServiceContainer, sql: string): Promise<string> {
    return succeeded(container.container, [
      'psql',
      '-U',
      this.#options.user,
      '-d',
      'postgres',
      '-c',
      sql,
    ]);
  }

  #acquire(
    database: string,
    mode: 'serve' | 'reuse',
  ): Promise<ServiceContainer> {
    const { image, password, user, labels } = this.#options;
    return this.#docker[mode](
      {
        Image: image,
        Labels: { ...labels, [KIND_LABEL]: postgres.kind },
        Env: [
          `POSTGRES_PASSWORD=${password}`,
          `POSTGRES_DB=${database}`,
          `POSTGRES_USER=${user}`,
        ],
        Cmd: ['-c', `max_wal_size=${MAX_WAL_MB}MB`],
        HostConfig: {
          Tmpfs: { '/var/lib/postgresql': `rw,size=${DISK_MB}m` },
          MemorySwappiness: 0,
        },
      },
      {
        internalPort: 5432,
        healthy: (container, signal) =>
          this.#ready(container, database, signal),
      },
    );
  }

  #ready(
    container: ServiceContainer,
    database: string,
    signal: AbortSignal,
  ): Promise<void> {
    const { user } = this.#options;
    // TCP excludes PostgreSQL's temporary, socket-only initialization server.
    return retryUntilReady(
      async () => {
        await succeeded(container.container, [
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          user,
        ]);
        await succeeded(container.container, [
          'psql',
          '-h',
          '127.0.0.1',
          '-U',
          user,
          '-d',
          database,
          '-c',
          'SELECT 1',
        ]);
      },
      { maxRetryTime: 60_000, signal },
    );
  }

  #handle(
    container: ServiceContainer,
    database: string,
    release: () => Promise<void>,
  ): PostgresDatabase {
    const { image, user, password } = this.#options;
    const { host, port } = container;
    const pools = new OwnedPools<pg.Pool>('client');
    const cleanup = () => pools.dispose(release);
    return {
      connectionString: `postgresql://${user}:${password}@${host}:${port}/${database}`,
      image,
      user,
      password,
      database,
      containerId: container.container.id,
      host,
      port,
      pool: (options) =>
        // A connection string would override the options' host and port.
        pools.add(() =>
          owned({ host, port, ...options, database, user, password }),
        ),
      cleanup,
      [Symbol.asyncDispose]: cleanup,
    };
  }
}
