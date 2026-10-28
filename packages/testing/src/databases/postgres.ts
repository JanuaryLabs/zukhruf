import { timebox } from '../async/timebox.ts';
import { readRun } from '../docker/run-records.ts';
import type { ServiceContainer } from '../docker/service-container.ts';
import { DockerTestbed } from '../docker/testbed.ts';
import { KIND_LABEL, databaseName } from './collector.ts';
import type { Database, DatabaseOptions } from './database.ts';
import { postgres } from './postgres-collector.ts';
import { succeeded } from './succeeded.ts';

export type { Database, DatabaseOptions } from './database.ts';

export interface PostgresOptions extends DatabaseOptions {
  user?: string;
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
  async database(): Promise<Database> {
    const container = await this.#acquire('postgres', 'reuse');
    const database = databaseName(this.#runId);
    const server = { container: container.container, user: this.#options.user };
    try {
      await this.#sql(container, `CREATE DATABASE ${database}`);
    } catch (error) {
      await container.disconnect();
      throw error;
    }
    return this.#handle(container, database, async () => {
      await postgres.drop(server, database, {}).catch(() => {
        /* Best-effort: the run's cleanup drops a database that disposal left. */
      });
      await container.disconnect();
    });
  }

  /** Start a dedicated server; the returned handle owns its container. */
  async start(): Promise<Database> {
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
        HostConfig: {
          Tmpfs: { '/var/lib/postgresql': 'rw,size=512m' },
          MemorySwappiness: 0,
        },
      },
      {
        internalPort: 5432,
        healthy: (container) => this.#ready(container, database),
      },
    );
  }

  #ready(container: ServiceContainer, database: string): Promise<void> {
    const { user } = this.#options;
    // TCP excludes PostgreSQL's temporary, socket-only initialization server.
    return timebox(
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
      { maxRetryTime: 60_000 },
    );
  }

  #handle(
    container: ServiceContainer,
    database: string,
    cleanup: () => Promise<void>,
  ): Database {
    const { image, user, password } = this.#options;
    return {
      connectionString: `postgresql://${user}:${password}@${container.host}:${container.port}/${database}`,
      image,
      user,
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
