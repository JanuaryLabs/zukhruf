import pg from 'pg';

import { readRun } from '../docker/run-records.ts';
import type { ServiceContainer } from '../docker/service-container.ts';
import { DockerTestbed } from '../docker/testbed.ts';
import { forLogMessage } from '../docker/wait-strategy.ts';
import { KIND_LABEL } from './collector.ts';
import {
  type SharedDatabase,
  createSharedDatabase,
} from './database-record.ts';
import type { Database, DatabaseOptions } from './database.ts';
import { type OwnedPool, OwnedPools, disposablePool } from './owned-pools.ts';
import { postgres } from './postgres-collector.ts';
import { succeeded } from './succeeded.ts';

export type { Database, DatabaseOptions } from './database.ts';

/** The server's own tmpfs mount, the data directory with its WAL. */
const DATA_DIRECTORY = '/var/lib/postgresql';
const DATA_MOUNT = 'rw,size=512m';

/**
 * The suffixes of a tmpfs size=, each 1024 times the one before. Docker
 * passes the options of HostConfig.Tmpfs to the mount unchanged (moby
 * daemon/oci_linux.go; MergeTmpfsOptions in moby/sys mount/flags_unix.go
 * keeps the last size=), so Linux parses size= with memparse: a number with
 * an optional k, m, g, t, p or e, of either case (lib/cmdline.c), or a
 * percent of the RAM (mm/shmem.c). It has no b suffix.
 */
const UNITS = ['', 'k', 'm', 'g', 't', 'p', 'e'];

/**
 * The flags that let WAL take a quarter of the disk of the data directory, so
 * the databases keep the rest. The 1 GB default was twice the 512 MB disk: a
 * load filled it before a checkpoint (#4940). max_wal_size "is never a hard
 * limit", so the rest is also its headroom; no archiving, slot or
 * wal_keep_size (default 0) keeps WAL past it, and the min_wal_size default of
 * 80 MB is under it
 * (https://www.postgresql.org/docs/current/wal-configuration.html). A mount
 * with no size=, or size=0, has no fixed disk to fit, so it keeps the default.
 */
function walFlags(options: string): string[] {
  const size = options
    .split(',')
    .findLast((option) => option.startsWith('size='))
    ?.slice('size='.length);
  if (size === undefined) return [];
  const match = /^(0|[1-9]\d*)([kmgtpe]?)$/i.exec(size);
  if (match === null)
    throw new TypeError(
      `The size=${size} of ${DATA_DIRECTORY} is not a number of bytes with an optional k, m, g, t, p or e, so it gives no max_wal_size.`,
    );
  // Both groups take part in every match, so the defaults never apply.
  const [, digits = '', suffix = ''] = match;
  const bytes = Number(digits) * 1024 ** UNITS.indexOf(suffix.toLowerCase());
  if (bytes === 0) return [];
  return ['-c', `max_wal_size=${Math.floor(bytes / 4 / 2 ** 20)}MB`];
}

export interface PostgresOptions extends DatabaseOptions {
  user?: string;
  /**
   * Testcontainers' withTmpFs: each container path to the options of its tmpfs
   * mount, as Docker's HostConfig.Tmpfs takes them. The entries merge over the
   * server's own mount of /var/lib/postgresql (rw,size=512m), so a path the
   * caller names replaces that mount's options. max_wal_size is a quarter of
   * the size= of the data directory's mount.
   */
  tmpFs?: Record<string, string>;
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
    tmpFs,
  }: PostgresOptions) {
    this.#docker = new DockerTestbed({ environment });
    this.#runId = readRun(environment)?.id;
    const mounts = { [DATA_DIRECTORY]: DATA_MOUNT, ...tmpFs };
    const wal = walFlags(mounts[DATA_DIRECTORY]);
    this.#options = { image, password, database, user, labels, mounts, wal };
  }

  /** Create an isolated database on the persistent shared server. */
  async database(): Promise<PostgresDatabase> {
    const container = await this.#acquire('postgres', 'reuse');
    let database: SharedDatabase;
    try {
      database = await createSharedDatabase(
        this.#docker,
        this.#runId,
        postgres,
        container.container,
        this.#options.user,
        (name) => this.#sql(container, `CREATE DATABASE ${name}`),
      );
    } catch (error) {
      await container.disconnect();
      throw error;
    }
    return this.#handle(container, database.name, async () => {
      await database.drop();
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
    const { image, password, user, labels, mounts, wal } = this.#options;
    return this.#docker[mode](
      {
        Image: image,
        Labels: { ...labels, [KIND_LABEL]: postgres.kind },
        Env: [
          `POSTGRES_PASSWORD=${password}`,
          `POSTGRES_DB=${database}`,
          `POSTGRES_USER=${user}`,
        ],
        ...(wal.length > 0 && { Cmd: wal }),
        HostConfig: {
          Tmpfs: mounts,
          MemorySwappiness: 0,
        },
      },
      {
        internalPort: 5432,
        // The entrypoint's temporary initialization server prints the first
        // ready line and listens on its socket only; the final server prints
        // the second.
        wait: {
          until: forLogMessage(
            'database system is ready to accept connections',
            { times: 2 },
          ),
          timeout: 60_000,
        },
      },
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
