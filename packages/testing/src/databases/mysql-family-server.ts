import { randomUUID } from 'node:crypto';

import { timebox } from '../async/timebox.ts';
import type { ServiceContainer } from '../docker/container.ts';
import type { Docker } from '../docker/docker.ts';
import type { Database, DatabaseOptions } from './database.ts';

export interface MysqlFamilyDatabase extends Database {
  query: (sql: string) => Promise<Record<string, string | null>[]>;
}

/** The image creates only root, from the root password in its environment. */
const user = 'root';

/**
 * A template method for servers that speak MySQL's protocol and client flags:
 * acquisitions, readiness, queries and the batch parser stay the same. A
 * subclass names the client in its image, the connection string's scheme and
 * the environment, and passes its default image to this constructor.
 */
export abstract class MysqlFamilyServer {
  readonly #docker: Docker;
  readonly #options;

  protected abstract readonly client: string;
  protected abstract readonly scheme: string;
  protected abstract environment(
    password: string,
    database: string,
  ): Record<string, string>;

  constructor({
    docker,
    image,
    password = 'testpassword',
    database = 'app',
    labels,
  }: DatabaseOptions & { image: string }) {
    this.#docker = docker;
    this.#options = { image, password, database, labels };
  }

  /** Create an isolated database on the persistent shared server. */
  async database(): Promise<MysqlFamilyDatabase> {
    const container = await this.#acquire('app', 'reuse');
    const database = `test_${randomUUID().replaceAll('-', '')}`;
    try {
      await this.#sql(container, `CREATE DATABASE \`${database}\``);
    } catch (error) {
      await container.disconnect();
      throw error;
    }
    return this.#handle(container, database, async () => {
      await this.#sql(
        container,
        `DROP DATABASE IF EXISTS \`${database}\``,
      ).catch(() => {
        /* Best-effort cleanup after external removal. */
      });
      await container.disconnect();
    });
  }

  /** Start a dedicated server; the returned handle owns its container. */
  async start(): Promise<MysqlFamilyDatabase> {
    const { database } = this.#options;
    const container = await this.#acquire(database, 'serve');
    return this.#handle(container, database, () => container.cleanup());
  }

  #sql(container: ServiceContainer, sql: string) {
    const { password } = this.#options;
    return container.exec([
      this.client,
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
    const { stdout } = await container.exec([
      this.client,
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
    return this.#docker[mode]({
      image,
      labels,
      internalPort: 3306,
      env: this.environment(password, database),
      tmpfs: ['/var/lib/mysql:rw,size=512m'],
      memorySwappiness: 0,
      healthy: (container) => this.#ready(container),
    });
  }

  #ready(container: ServiceContainer) {
    const { password } = this.#options;
    // TCP excludes the entrypoint's temporary, socket-only initialization server.
    return timebox(
      () =>
        container.exec([
          this.client,
          '-h',
          '127.0.0.1',
          `-u${user}`,
          `-p${password}`,
          '--execute',
          'SELECT 1',
        ]),
      { maxRetryTime: 90_000 },
    );
  }

  #handle(
    container: ServiceContainer,
    database: string,
    cleanup: () => Promise<void>,
  ): MysqlFamilyDatabase {
    const { image, password } = this.#options;
    return {
      connectionString: `${this.scheme}://${user}:${password}@${container.host}:${container.port}/${database}`,
      image,
      user,
      password,
      database,
      containerId: container.containerId,
      host: container.host,
      port: container.port,
      query: (sql) => this.#query(container, database, sql),
      cleanup,
      [Symbol.asyncDispose]: cleanup,
    };
  }
}
