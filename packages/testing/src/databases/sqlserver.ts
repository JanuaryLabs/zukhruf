import sql from 'mssql';

import { timebox } from '../async/timebox.ts';
import { readRun } from '../docker/run-records.ts';
import type { ServiceContainer } from '../docker/service-container.ts';
import { DockerTestbed } from '../docker/testbed.ts';
import { KIND_LABEL, databaseName, dropDatabase } from './collector.ts';
import type { Database, DatabaseOptions } from './database.ts';
import {
  type SqlServerServer,
  connectionString,
  sqlserver,
} from './sqlserver-collector.ts';

export type { Database, DatabaseOptions } from './database.ts';

export const SQL_SERVER_FULL_IMAGE =
  'mcr.microsoft.com/mssql/server:2022-latest';

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
  async database(): Promise<Database> {
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
        } catch {
          // Best-effort: the run's cleanup drops a database that disposal left.
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
  async start(): Promise<Database> {
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
      await pool.close().catch(() => {});
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
          timebox(() => this.#ping(container), {
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
    cleanup: () => Promise<void>,
  ): Database {
    const { password } = this.#options;
    return {
      connectionString: this.#connectionString(container, database),
      image,
      user: 'sa',
      password,
      database,
      containerId: container.container.id,
      host: container.host,
      port: container.port,
      cleanup,
      [Symbol.asyncDispose]: cleanup,
    };
  }
}
