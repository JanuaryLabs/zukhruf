import { retryUntilReady } from '../async/retry-until-ready.ts';
import { readRun } from '../docker/run-records.ts';
import type { ServiceContainer } from '../docker/service-container.ts';
import { DockerTestbed } from '../docker/testbed.ts';
import { KIND_LABEL, databaseName, dropDatabase } from './collector.ts';
import type { Database, DatabaseOptions } from './database.ts';
import { type MysqlFamilyCollector, user } from './mysql-family-collector.ts';
import { type OwnedPool, OwnedPools } from './owned-pools.ts';
import { succeeded } from './succeeded.ts';

/** A handle of a database of the MySQL family that owns the pools it gives. */
export interface MysqlFamilyDatabase<Pool, PoolOptions> extends Database {
  query: (sql: string) => Promise<Record<string, string | null>[]>;
  /** A pool of this database; the disposal of the handle ends it before the drop. */
  pool(options?: PoolOptions): Pool;
}

/** The server of a handle; the options of a pool can route it through a proxy. */
export interface PoolServer {
  host: string;
  port: number;
}

/** The database and the user of a handle, which the options of a pool cannot change. */
export interface PoolAccount {
  database: string;
  user: string;
  password: string;
}

/**
 * A template method for servers that speak MySQL's protocol and client flags:
 * acquisitions, readiness, queries, the batch parser and the order of the
 * disposal stay the same. A subclass names its collector (its kind and the
 * client in its image), the connection string's scheme, the environment and
 * the pool of its driver, and passes its default image to this constructor.
 */
export abstract class MysqlFamilyServer<Pool, PoolOptions> {
  readonly #docker: DockerTestbed;
  readonly #runId: string | undefined;
  readonly #options;

  protected abstract readonly collector: MysqlFamilyCollector;
  protected abstract readonly scheme: string;
  protected abstract environment(
    password: string,
    database: string,
  ): Record<string, string>;
  /**
   * A pool of the driver, which its owner ends with `end`. The options
   * override the server, and the account overrides the options.
   */
  protected abstract ownedPool(
    server: PoolServer,
    options: PoolOptions | undefined,
    account: PoolAccount,
  ): OwnedPool<Pool>;

  constructor({
    environment,
    image,
    password = 'testpassword',
    database = 'app',
    labels,
  }: DatabaseOptions & { image: string }) {
    this.#docker = new DockerTestbed({ environment });
    this.#runId = readRun(environment)?.id;
    this.#options = { image, password, database, labels };
  }

  /** Create an isolated database on the persistent shared server. */
  async database(): Promise<MysqlFamilyDatabase<Pool, PoolOptions>> {
    const container = await this.#acquire('app', 'reuse');
    const database = databaseName(this.#runId);
    try {
      await this.#sql(container, `CREATE DATABASE \`${database}\``);
    } catch (error) {
      await container.disconnect();
      throw error;
    }
    return this.#handle(container, database, async () => {
      await dropDatabase(
        this.collector,
        container.container,
        this.#options.password,
        database,
      ).catch(() => {
        /* Best-effort: the run's cleanup drops a database that disposal left. */
      });
      await container.disconnect();
    });
  }

  /** Start a dedicated server; the returned handle owns its container. */
  async start(): Promise<MysqlFamilyDatabase<Pool, PoolOptions>> {
    const { database } = this.#options;
    const container = await this.#acquire(database, 'serve');
    return this.#handle(container, database, () => container.cleanup());
  }

  #sql(container: ServiceContainer, sql: string): Promise<string> {
    const { password } = this.#options;
    return succeeded(container.container, [
      this.collector.client,
      `-u${user}`,
      `-p${password}`,
      '--execute',
      sql,
    ]);
  }

  async #query(
    container: ServiceContainer,
    database: string,
    sql: string,
  ): Promise<Record<string, string | null>[]> {
    const { password } = this.#options;
    const stdout = await succeeded(container.container, [
      this.collector.client,
      `-u${user}`,
      `-p${password}`,
      '--database',
      database,
      '--batch',
      '--raw',
      '--execute',
      sql,
    ]);
    return this.#parseBatch(stdout);
  }

  #parseBatch(stdout: string): Record<string, string | null>[] {
    const [headerLine, ...rows] = stdout.trimEnd().split('\n').filter(Boolean);
    if (headerLine === undefined) return [];
    const headers = headerLine.split('\t');
    return rows.map((line) => {
      const values = line.split('\t');
      return Object.fromEntries(
        headers.map((header, index) => {
          const value = values[index];
          return [
            header,
            value === undefined || value === 'NULL' ? null : value,
          ];
        }),
      );
    });
  }

  #acquire(
    database: string,
    mode: 'serve' | 'reuse',
  ): Promise<ServiceContainer> {
    const { image, password, labels } = this.#options;
    return this.#docker[mode](
      {
        Image: image,
        Labels: { ...labels, [KIND_LABEL]: this.collector.kind },
        Env: Object.entries(this.environment(password, database)).map(
          ([key, value]) => `${key}=${value}`,
        ),
        HostConfig: {
          Tmpfs: { '/var/lib/mysql': 'rw,size=512m' },
          MemorySwappiness: 0,
        },
      },
      {
        internalPort: 3306,
        healthy: (container, signal) => this.#ready(container, signal),
      },
    );
  }

  #ready(container: ServiceContainer, signal: AbortSignal) {
    const { password } = this.#options;
    // TCP excludes the entrypoint's temporary, socket-only initialization server.
    return retryUntilReady(
      () =>
        succeeded(container.container, [
          this.collector.client,
          '-h',
          '127.0.0.1',
          `-u${user}`,
          `-p${password}`,
          '--execute',
          'SELECT 1',
        ]),
      { maxRetryTime: 90_000, signal },
    );
  }

  #handle(
    container: ServiceContainer,
    database: string,
    release: () => Promise<void>,
  ): MysqlFamilyDatabase<Pool, PoolOptions> {
    const { image, password } = this.#options;
    const { host, port } = container;
    const pools = new OwnedPools<Pool>('connection');
    const cleanup = () => pools.dispose(release);
    return {
      connectionString: `${this.scheme}://${user}:${password}@${host}:${port}/${database}`,
      image,
      user,
      password,
      database,
      containerId: container.container.id,
      host,
      port,
      query: (sql) => this.#query(container, database, sql),
      pool: (options) =>
        pools.add(() =>
          this.ownedPool({ host, port }, options, { database, user, password }),
        ),
      cleanup,
      [Symbol.asyncDispose]: cleanup,
    };
  }
}
