import type { PoolConnection } from 'mysql2';
import mysql from 'mysql2/promise';

import type { DatabaseOptions } from './database.ts';
import { mysql as collector } from './mysql-family-collector.ts';
import {
  type MysqlFamilyDatabase,
  MysqlFamilyServer,
  type OwnedPool,
  type PoolAccount,
  type PoolServer,
  leak,
} from './mysql-family-server.ts';

export type { Database, DatabaseOptions } from './database.ts';

export type MysqlOptions = DatabaseOptions;

/** The options of a pool of a handle: the handle names the database and the user. */
export type MysqlPoolOptions = Omit<
  mysql.PoolOptions,
  'uri' | 'database' | 'user' | 'password'
>;

/**
 * A pool of `mysql2/promise` whose end belongs to its owner. It has no `end`,
 * no `[Symbol.asyncDispose]` and no callback `pool`, so `await using` cannot
 * end it: mysql2 has no public sign that a pool is ending, and a second
 * `end()` rejects.
 */
export type MysqlPool = Omit<
  mysql.Pool,
  'end' | 'pool' | typeof Symbol.asyncDispose
>;

/** A handle of a MySQL database that owns the pools it gives. */
export type MysqlDatabase = MysqlFamilyDatabase<MysqlPool, MysqlPoolOptions>;

/**
 * Ends the pool fully, and resolves with the number of connections that were
 * still checked out. `pool.end()` resolves when each Quit has started, before
 * the sockets close; a connection emits `end` once the server closed its
 * socket, and mysql2 itself lets go of a connection on `end` or `error`.
 */
function owned(options: mysql.PoolOptions): OwnedPool<MysqlPool> {
  const pool = mysql.createPool(options);
  const closed: Promise<void>[] = [];
  const checkedOut = new Set<PoolConnection>();
  pool.pool.on('connection', (connection) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const gone = () => {
      checkedOut.delete(connection);
      resolve();
    };
    connection.once('end', gone).once('error', gone);
    closed.push(promise);
  });
  pool.pool.on('acquire', (connection) => checkedOut.add(connection));
  pool.pool.on('release', (connection) => checkedOut.delete(connection));
  return {
    pool,
    async end() {
      // A connection that the test destroyed is 'disconnected' and closing.
      const leaked = [...checkedOut].filter(
        (connection) => connection.state !== 'disconnected',
      );
      // Before end(): an ended pool keeps a destroyed connection in its list,
      // and its end() waits behind the connection's running statement.
      for (const connection of leaked) connection.destroy();
      await pool.end();
      await Promise.all(closed);
      return leaked.length;
    },
  };
}

/**
 * A pool for a test that has no handle, such as a pool of another user. Its
 * disposal resolves once the server closed each connection of the pool, and
 * rejects when it destroyed a connection that was still checked out.
 */
export function mysqlPool(
  options: mysql.PoolOptions,
): AsyncDisposable & { readonly pool: MysqlPool } {
  const { pool, end } = owned(options);
  return {
    pool,
    async [Symbol.asyncDispose]() {
      const leaked = await end();
      if (leaked > 0) throw leak(leaked, 'a pool');
    },
  };
}

export class Mysql extends MysqlFamilyServer<MysqlPool, MysqlPoolOptions> {
  protected override readonly collector = collector;
  protected override readonly scheme = 'mysql';

  constructor({ image = 'mysql:lts', ...options }: MysqlOptions) {
    super({ ...options, image });
  }

  protected override environment(password: string, database: string) {
    return { MYSQL_ROOT_PASSWORD: password, MYSQL_DATABASE: database };
  }

  protected override ownedPool(
    server: PoolServer,
    options: MysqlPoolOptions | undefined,
    account: PoolAccount,
  ) {
    return owned({ ...server, ...options, ...account });
  }
}
