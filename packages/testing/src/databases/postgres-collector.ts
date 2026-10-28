import type { CancelOptions, Container } from '@zukhruf/docker';

import type { Collector } from './collector.ts';
import { succeeded } from './succeeded.ts';

export interface PostgresServer {
  container: Container;
  user: string;
}

const psql = (
  { container, user }: PostgresServer,
  args: string[],
  cancel: CancelOptions,
) =>
  succeeded(container, ['psql', '-U', user, '-d', 'postgres', ...args], cancel);

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
  async list(server, cancel) {
    const stdout = await psql(
      server,
      [
        '-At',
        '-c',
        "SELECT datname FROM pg_database WHERE datname LIKE 'test%'",
      ],
      cancel,
    );
    return stdout.split('\n').filter(Boolean);
  },
  async drop(server, name, cancel) {
    await psql(
      server,
      ['-c', `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`],
      cancel,
    );
  },
};
