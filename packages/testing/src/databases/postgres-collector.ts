import type { Collector } from './collector.ts';

/** Runs `psql` in the server's container. */
export const postgres: Collector = {
  kind: 'postgres',
  credential: { variable: 'POSTGRES_USER', fallback: 'postgres' },
  command: (user, sql) => [
    'psql',
    '-U',
    user,
    '-d',
    'postgres',
    '-At',
    '-c',
    sql,
  ],
  list: "SELECT datname FROM pg_database WHERE datname LIKE 'test%'",
  drop: (name) => `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
};
