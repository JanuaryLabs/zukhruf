import { timebox } from '../async/timebox.ts';
import type { ServiceContainer } from '../docker/service-container.ts';
import { TestRun } from '../docker/test-run.ts';
import { DockerTestbed } from '../docker/testbed.ts';
import { KIND_LABEL, databaseName } from './collector.ts';
import type { Database, DatabaseOptions } from './database.ts';
import { type MysqlFamilyCollector, user } from './mysql-family-collector.ts';
import { succeeded } from './succeeded.ts';

export interface MysqlFamilyDatabase extends Database {
  query: (sql: string) => Promise<Record<string, string | null>[]>;
}

/**
 * A template method for servers that speak MySQL's protocol and client flags:
 * acquisitions, readiness, queries and the batch parser stay the same. A
 * subclass names its collector (its kind and the client in its image), the
 * connection string's scheme and the environment, and passes its default
 * image to this constructor.
 */
export abstract class MysqlFamilyServer {
  readonly #docker: DockerTestbed;
  readonly #run: TestRun | undefined;
  readonly #options;

  protected abstract readonly collector: MysqlFamilyCollector;
  protected abstract readonly scheme: string;
  protected abstract environment(
    password: string,
    database: string,
  ): Record<string, string>;

  constructor({
    environment,
    image,
    password = 'testpassword',
    database = 'app',
    labels,
  }: DatabaseOptions & { image: string }) {
    this.#docker = new DockerTestbed({ environment });
    this.#run = TestRun.fromEnvironment(environment);
    this.#options = { image, password, database, labels };
  }

  /** Create an isolated database on the persistent shared server. */
  async database(): Promise<MysqlFamilyDatabase> {
    const container = await this.#acquire('app', 'reuse');
    const database = databaseName(this.#run);
    const server = {
      container: container.container,
      password: this.#options.password,
    };
    try {
      await this.#sql(container, `CREATE DATABASE \`${database}\``);
    } catch (error) {
      await container.disconnect();
      throw error;
    }
    return this.#handle(container, database, async () => {
      await this.collector.drop(server, database).catch(() => {
        /* Best-effort: the run's cleanup drops a database that disposal left. */
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
    return this.#docker[mode]({
      image,
      labels: { ...labels, [KIND_LABEL]: this.collector.kind },
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
        succeeded(container.container, [
          this.collector.client,
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
      containerId: container.container.id,
      host: container.host,
      port: container.port,
      query: (sql) => this.#query(container, database, sql),
      cleanup,
      [Symbol.asyncDispose]: cleanup,
    };
  }
}
