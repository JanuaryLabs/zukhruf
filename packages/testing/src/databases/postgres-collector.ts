import type { Container } from '@zukhruf/docker';

import type { Collector } from './collector.ts';
import { succeeded } from './succeeded.ts';

export interface PostgresServer {
  container: Container;
  user: string;
}

const psql = ({ container, user }: PostgresServer, args: string[]) =>
  succeeded(container, ['psql', '-U', user, '-d', 'postgres', ...args]);

/** Runs `psql` in the server's container. */
export const postgres: Collector<PostgresServer> = {
  kind: 'postgres',
  async open(container, environment) {
    return {
      container,
      user: environment.POSTGRES_USER ?? 'postgres',
      [Symbol.asyncDispose]: async () => {},
    };
  },
  async list(server) {
    const stdout = await psql(server, [
      '-At',
      '-c',
      "SELECT datname FROM pg_database WHERE datname LIKE 'test%'",
    ]);
    return stdout.split('\n').filter(Boolean);
  },
  async drop(server, name) {
    await psql(server, [
      '-c',
      `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
    ]);
  },
};
