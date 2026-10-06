import { randomUUID } from 'node:crypto';

import sql from 'mssql';
import pMemoize from 'p-memoize';

import { timebox } from '../async/timebox.ts';
import type { ServiceContainer } from '../docker/container.ts';
import type { Docker } from '../docker/docker.ts';
import type { Database, DatabaseOptions } from './database.ts';

export type { Database, DatabaseOptions } from './database.ts';

export const SQL_SERVER_FULL_IMAGE =
  'mcr.microsoft.com/mssql/server:2022-latest';
export const SQL_SERVER_EDGE_IMAGE = 'mcr.microsoft.com/azure-sql-edge:latest';

/** SQL Server test configuration. Without an image, the engine's architecture picks one. */
export class SqlServer {
  readonly #docker: Docker;
  readonly #options;
  readonly #image = pMemoize(async (): Promise<string> => {
    if (this.#options.image) return this.#options.image;
    if (!(await this.#docker.isAvailable()))
      throw new Error('Docker is required for container-backed tests');
    const { architecture } = await this.#docker.info();
    return ['arm64', 'aarch64'].includes(architecture)
      ? SQL_SERVER_EDGE_IMAGE
      : SQL_SERVER_FULL_IMAGE;
  });

  constructor({
    docker,
    image,
    password = 'StrongP@ssw0rd123!',
    database = 'testdb',
    labels,
  }: DatabaseOptions) {
    this.#docker = docker;
    this.#options = { image, password, database, labels };
  }

  /** Create an isolated database on the persistent shared server. */
  async database(): Promise<Database> {
    const image = await this.#image();
    const container = await this.#acquire(image, 'reuse');
    const database = `test_${randomUUID().replaceAll('-', '')}`;
    try {
      await this.#createDatabase(container, database);
      return this.#handle(container, image, database, async () => {
        try {
          await this.#dropDatabase(container, database);
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
    const image = await this.#image();
    const container = await this.#acquire(image, 'serve');
    const { database } = this.#options;
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

  #connectionString(container: ServiceContainer, database: string): string {
    return `Server=${container.host},${container.port};Database=${database};User Id=sa;Password=${this.#options.password};TrustServerCertificate=true;Encrypt=false;`;
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

  async #dropDatabase(
    container: ServiceContainer,
    database: string,
  ): Promise<void> {
    const pool = new sql.ConnectionPool(
      this.#connectionString(container, 'master'),
    );
    try {
      await pool.connect();
      await pool
        .request()
        .query(
          `IF DB_ID('${database}') IS NOT NULL BEGIN ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${database}]; END`,
        );
    } catch {
      // Best-effort cleanup; a leaked database lasts until container removal.
    } finally {
      await pool.close().catch(() => {});
    }
  }

  #acquire(image: string, mode: 'serve' | 'reuse'): Promise<ServiceContainer> {
    const { password, labels } = this.#options;
    return this.#docker[mode]({
      image,
      labels,
      env: {
        ACCEPT_EULA: 'Y',
        MSSQL_SA_PASSWORD: password,
        MSSQL_MEMORY_LIMIT_MB: '2048',
        ...(image.includes('azure-sql-edge') ? {} : { MSSQL_PID: 'Express' }),
      },
      internalPort: 1433,
      tmpfs: ['/var/opt/mssql:rw,size=2g,mode=1777'],
      memory: '3g',
      memorySwappiness: 0,
      healthy: (container) =>
        timebox(() => this.#ping(container), { maxRetryTime: 180_000 }),
    });
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
      containerId: container.containerId,
      host: container.host,
      port: container.port,
      cleanup,
      [Symbol.asyncDispose]: cleanup,
    };
  }
}
