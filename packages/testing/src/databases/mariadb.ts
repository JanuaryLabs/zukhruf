import mariadb, {
  type Connection,
  type Pool,
  type PoolConfig,
  SqlError,
} from 'mariadb';

import type { DatabaseOptions } from './database.ts';
import { mariadb as collector } from './mysql-family-collector.ts';
import {
  type MysqlFamilyDatabase,
  MysqlFamilyServer,
  type OwnedPool,
  type PoolAccount,
  type PoolServer,
  leak,
} from './mysql-family-server.ts';

export type { Database, DatabaseOptions } from './database.ts';

export type MariadbOptions = DatabaseOptions;

/** The options of a pool of a handle: the handle names the database and the user. */
export type MariadbPoolOptions = Omit<
  PoolConfig,
  'database' | 'user' | 'password'
>;

/**
 * A pool of `mariadb` whose end belongs to its owner. It has no `end` and no
 * `[Symbol.asyncDispose]`, so `await using` cannot end it: mariadb's `end()`
 * removes every listener of the pool, and waits up to 10 s for a connection
 * that is still checked out.
 */
export type MariadbPool = Omit<Pool, 'end' | typeof Symbol.asyncDispose>;

/** A handle of a MariaDB database that owns the pools it gives. */
export type MariadbDatabase = MysqlFamilyDatabase<
  MariadbPool,
  MariadbPoolOptions
>;

/** MariaDB's error for a KILL of a session that has already ended. */
const ER_NO_SUCH_THREAD = 1094;

/**
 * Ends the session of each connection on the server with KILL CONNECTION, on
 * a connection of its own, and resolves once each connection has seen the
 * server close its socket (`end`).
 */
async function kill(config: PoolConfig, connections: Connection[]) {
  const closed = connections.map(
    (connection) =>
      new Promise<void>((resolve) => connection.on('end', resolve)),
  );
  {
    await using killer = await mariadb.createConnection(config);
    for (const { threadId } of connections) {
      try {
        await killer.query(`KILL CONNECTION ${threadId}`);
      } catch (error) {
        if (!(error instanceof SqlError && error.errno === ER_NO_SUCH_THREAD))
          throw error;
      }
    }
  }
  await Promise.all(closed);
}

/**
 * Ends the pool fully, and resolves with the number of connections that were
 * still checked out. `pool.end()` destroys the socket of each idle connection
 * before it resolves. A connection that is still checked out would make it
 * wait up to 10 s, so its session is killed first.
 */
function owned(config: PoolConfig): OwnedPool<MariadbPool> {
  const pool = mariadb.createPool(config);
  const checkedOut = new Set<Connection>();
  pool.on('acquire', (connection) => checkedOut.add(connection));
  pool.on('release', (connection) => checkedOut.delete(connection));
  return {
    pool,
    async end() {
      // A connection that ended, or that the test destroyed, is not valid.
      const leaked = [...checkedOut].filter((connection) =>
        connection.isValid(),
      );
      if (leaked.length > 0) await kill(config, leaked);
      await pool.end();
      return leaked.length;
    },
  };
}

/**
 * A pool for a test that has no handle, such as a pool of another user. Its
 * disposal resolves once the socket of each connection of the pool has
 * closed, and rejects when it ended a connection that was still checked out.
 */
export function mariadbPool(
  config: PoolConfig,
): AsyncDisposable & { readonly pool: MariadbPool } {
  const { pool, end } = owned(config);
  return {
    pool,
    async [Symbol.asyncDispose]() {
      const leaked = await end();
      if (leaked > 0) throw leak(leaked, 'a pool');
    },
  };
}

export class Mariadb extends MysqlFamilyServer<
  MariadbPool,
  MariadbPoolOptions
> {
  protected override readonly collector = collector;
  protected override readonly scheme = 'mariadb';

  constructor({ image = 'mariadb:lts', ...options }: MariadbOptions) {
    super({ ...options, image });
  }

  protected override environment(password: string, database: string) {
    return { MARIADB_ROOT_PASSWORD: password, MARIADB_DATABASE: database };
  }

  protected override ownedPool(
    server: PoolServer,
    options: MariadbPoolOptions | undefined,
    account: PoolAccount,
  ) {
    return owned({ ...server, ...options, ...account });
  }
}
