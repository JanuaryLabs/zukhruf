import { hash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';

import sql from 'mssql';

import { Docker, ImageNotFoundError } from '@zukhruf/docker';

import { readRun } from '../docker/run-records.ts';
import type { ServiceContainer } from '../docker/service-container.ts';
import { DockerTestbed, type DockerTestbedOptions } from '../docker/testbed.ts';
import { KIND_LABEL } from './collector.ts';
import { createSharedDatabase } from './database-record.ts';
import type { Database, DatabaseOptions } from './database.ts';
import { waitForLogMessage } from './log-message.ts';
import { type OwnedPool, OwnedPools } from './owned-pools.ts';
import {
  type SqlServerServer,
  connectionString,
  sqlserver,
} from './sqlserver-collector.ts';

export type { Database, DatabaseOptions } from './database.ts';

export const SQL_SERVER_FULL_IMAGE =
  'mcr.microsoft.com/mssql/server:2022-latest';

export interface SqlServerOptions extends DatabaseOptions {
  /**
   * Runs SQL Server with Full-Text Search: an image that the fixture builds
   * on the engine from `image`, once for each version of the server (ADR 0027).
   */
  fullTextSearch?: boolean;
}

/** Microsoft builds SQL Server for amd64 only, and the Dockerfile installs an amd64 package. */
const PLATFORM = 'linux/amd64';

/** The architectures that an engine reports in its `Architecture` when it runs amd64 natively. */
const NATIVE_ARCHITECTURES = new Set(['x86_64', 'amd64']);

/** The label of Microsoft's image that holds the version of its server. */
const VERSION_LABEL = 'com.microsoft.version';

/** The repository of packages.microsoft.com for each major version of the server. */
const REPOSITORIES = new Map([
  ['16', 'mssql-server-2022'],
  ['17', 'mssql-server-2025'],
]);

const FULL_TEXT_SEARCH_DOCKERFILE = new URL(
  'sqlserver-full-text-search.Dockerfile',
  import.meta.url,
);

/**
 * Builds the image with Full-Text Search from `base` on the engine, unless
 * the engine has it, and gives its tag. The tag holds the version of the
 * server and the hash of the Dockerfile, so a new base or a new Dockerfile
 * gives a new image.
 */
async function fullTextSearchImage(
  testbed: DockerTestbed,
  base: string,
): Promise<string> {
  const docker = await testbed.client();
  const dockerfile = await readFile(FULL_TEXT_SEARCH_DOCKERFILE, 'utf8');
  const version = (await pulledBase(docker, base)).Config?.Labels?.[
    VERSION_LABEL
  ];
  if (version === undefined)
    throw new Error(
      `The image ${base} has no label ${VERSION_LABEL}, so the fixture cannot find its mssql-server-fts package`,
    );
  const repository = REPOSITORIES.get(version.split('.')[0] ?? '');
  if (repository === undefined)
    throw new Error(
      `The image ${base} runs SQL Server ${version}: Full-Text Search is built only for 16 (2022) and 17 (2025)`,
    );
  const tag = `zukhruf-testing-sqlserver-fts:${version}-${hash('sha256', dockerfile).slice(0, 12)}`;
  await testbed.image(tag, (client) =>
    client.images.build(
      { files: [{ path: 'Dockerfile', data: dockerfile }] },
      {
        t: tag,
        buildargs: {
          BASE: base,
          SERVER_VERSION: version,
          REPOSITORY: repository,
        },
        platform: PLATFORM,
      },
    ),
  );
  return tag;
}

/**
 * The base image that the build uses, pulled first also when the engine has
 * an image of that name: a tag in a registry moves to a new server, and the
 * built tag must hold the label of that server, not of the stale local one.
 * The build pulls no image (`@zukhruf/docker` ADR 0016), and an inspect is
 * no presence check: the containerd store answers it for each platform of an
 * index, also with no content of that platform (ADR 0027).
 */
async function pulledBase(docker: Docker, base: string) {
  await docker.images.pull(base, { platform: PLATFORM }).catch((error) => {
    // A base built on this engine is in no registry: the build uses it.
    if (!(error instanceof ImageNotFoundError)) throw error;
  });
  const image = await docker.images.inspect(base);
  if (image === undefined)
    throw new Error(`The engine has no image ${base} after its pull`);
  return image;
}

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
    fullTextSearch = false,
  }: SqlServerOptions) {
    this.#docker = new DockerTestbed({ environment });
    this.#runId = readRun(environment)?.id;
    this.#options = { image, password, database, labels, fullTextSearch };
  }

  /**
   * Why the engine that `environment` selects cannot run SQL Server natively:
   * the engine's architecture and the image's platform, or `false` when the
   * engine runs amd64 itself. A test passes it as its `skip` option, for a
   * claim that holds only where amd64 is native: Microsoft does not support
   * SQL Server under emulation, and SQL Server 2025 crashes at start about once
   * in 41 starts on an arm64 Mac (#5469).
   */
  static async emulation({
    environment,
  }: DockerTestbedOptions): Promise<string | false> {
    await using docker = await Docker.connect({
      clock: globalThis,
      environment,
    });
    const { Architecture } = await docker.info();
    if (NATIVE_ARCHITECTURES.has(Architecture ?? '')) return false;
    return `the engine runs ${Architecture} and emulates the ${PLATFORM} of SQL Server, which Microsoft does not support`;
  }

  /** Create an isolated database on the persistent shared server. */
  async database(): Promise<SqlServerDatabase> {
    const image = await this.#image();
    const container = await this.#acquire(image, 'reuse');
    try {
      const database = await createSharedDatabase(
        this.#docker,
        this.#runId,
        sqlserver,
        container.container,
        this.#options.password,
        (name) => this.#createDatabase(container, name),
      );
      return this.#handle(container, image, database.name, async () => {
        try {
          await database.drop();
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
    const { database } = this.#options;
    const image = await this.#image();
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

  /** The image of the server: the `image` option, or the image with Full-Text Search built from it. */
  #image(): Promise<string> {
    const { image, fullTextSearch } = this.#options;
    if (!fullTextSearch) return Promise.resolve(image);
    return fullTextSearchImage(this.#docker, image);
  }

  #server({ host, port }: ServiceContainer): SqlServerServer {
    return { host, port, password: this.#options.password };
  }

  #connectionString(container: ServiceContainer, database: string): string {
    return connectionString(this.#server(container), database);
  }

  /**
   * Answers when the server runs a statement. With Full-Text Search, a server
   * that has no full-text component fails: its image lacks it.
   */
  async #ping(container: ServiceContainer, image: string): Promise<void> {
    const pool = new sql.ConnectionPool(
      this.#connectionString(container, 'master'),
    );
    try {
      await pool.connect();
      await pool.request().query('SELECT 1');
      if (!this.#options.fullTextSearch) return;
      const { recordset } = await pool
        .request()
        .query<{ installed: number | null }>(
          "SELECT FULLTEXTSERVICEPROPERTY('IsFullTextInstalled') AS installed",
        );
      if (recordset[0]?.installed !== 1)
        throw new Error(
          `The server of the image ${image} has no Full-Text Search: FULLTEXTSERVICEPROPERTY('IsFullTextInstalled') is ${String(recordset[0]?.installed)}`,
        );
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
        // SQL Server prints `SQL Server is now ready for client connections`
        // first, and `Recovery is complete` when its databases are up.
        healthy: async (container, signal) => {
          await waitForLogMessage(container.container, 'Recovery is complete', {
            timeout: 180_000,
            clock: globalThis,
            signal,
          });
          await this.#ping(container, image);
        },
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
