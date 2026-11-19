# A database handle owns its pools, and its disposal ends them before it drops the database

Status: Accepted 2026-11-19 (Ezz). Built for `Postgres` (backlog #3759, step 1). `Mysql`, `Mariadb` and `SqlServer` are the next steps, and are not built.

A test makes a database with `database()` of `Postgres`, `Mysql`, `Mariadb` or `SqlServer`, and builds a pool of the driver from the handle's `connectionString`. The test ends the pool, and then the handle's disposal drops the database. Two things go wrong:

- **The pool ends early.** `await pool.end()` of pg-pool resolves before the sockets of its clients close. The disposal then runs `DROP DATABASE … WITH (FORCE)` ([postgres-collector.ts](../../src/databases/postgres-collector.ts)), Postgres sends FATAL 57P01 to a backend that is still ending, and the pool's unhandled `error` fails the running test. The zukhruf replica proved it (#3305): `pool.end()` resolved with 300 of 300 sockets still open, and a drop right after it gave an uncaught 57P01 in 278 of 300 cycles.
- **A client never comes back.** A broken store under test keeps a client of the pool. `pool.end()` waits for that client, so the disposal hangs until the runner ends the process. In the step-1 mutation proof of #3737 (finding P1), the `pools` claim of mutex failed as it should, and then its teardown hung about 180 s more.

The same race is in three repositories: mutex (`postgresPool` in `packages/mutex/src/testing/subjects/postgres.ts`, `poolTo` and `mysql.createPool` in `subjects/mysql.ts`, `mariadb.createPool` in `subjects/mariadb.ts`), deepagents (#3369, 207 places) and factory (#3370). By [ADR 0016](./0016-a-test-helper-goes-into-an-area-when-three-repositories-have-its-knowledge-and-it-does-not-use-mock.md), the knowledge now goes into the areas.

The owner asked on 2026-10-30, about a bare `new pg.Pool`: "how can we make this illegal state unrepresented?". On 2026-11-03 he decided the shape:

> I recall we agreed with different session that pool returns from the db. that talk was about pg but this applies everywhere. we wanted not to represent illegal state so the choice was ... to return it from the db function itself to avoid anyone constructing pool themselves

On 2026-11-19 he decided how a test gives the pool to a store:

> why not just to give a pool to the store instead of connection string

Each Postgres store of deepagents (`PostgresStore`, `PostgresStreamStore`, `PostgresNotifyChangeSource`, text2sql's `PostgresFs`) tests `options.pool instanceof pg.Pool`, and leaves a pool that it was given alone. Thus a test gives the store `database.pool()`, and the handle owns the end of the pool. The product does not change.

## What each driver gives

The versions are the ones in `node_modules` on 2026-11-19. The disposal uses only the members and events that the types or the README of the driver name. It reads no private field and polls nothing.

| Engine     | Driver                                    | `end` resolves when                                                                                                                                                                                                                                                                                                            | Signal: a client's socket closed                                                                                                                                                                                                                | Forced close of a checked-out client                                                                                                                                                                                                                                                                                     |
| ---------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL | pg 8.23.1, pg-pool 3.14.0                 | The pool's list of clients is empty (`pg-pool/index.js:133-143`). `_remove` takes a client off the list, and only then calls the async `client.end()` (`:172-188`). Thus `end` resolves before the sockets close. It also waits for each checked-out client: `_clients` holds it until a release.                              | The pool's `remove` event (`pg-pool/index.js:181-182`), in the callback of `client.end()`. That callback waits for the connection's `end` (`pg/lib/client.js:829-833`), which is the socket's `close` (`pg/lib/connection.js:63-64`).           | `client.release(error)` (`@types/pg/index.d.ts:321`). A release with an error removes the client (`pg-pool/index.js:384-397`), and `client.end()` destroys the socket when a query is active (`pg/lib/client.js:822-824`), else it sends Terminate (`:826`).                                                             |
| MySQL      | mysql2 3.24.5 (`mysql2/promise`)          | Each connection's Quit command has started: `Quit.start` calls the callback before it writes the packet (`mysql2/lib/commands/quit.js:13-24`; `lib/base/pool.js:195-230`). Thus `end` also resolves before the sockets close. Quit waits behind the active command of a connection (`lib/base/connection.js:1167`).            | The connection's `end` event, emitted on the socket's `end` (`lib/base/connection.js:158-161`). The types do not name it (`typings/mysql/lib/Connection.d.ts:430` has only `on(event: string)`).                                                | `connection.destroy()` (`promise.d.ts:72`). It removes the connection from the pool while the pool is open (`lib/pool_connection.js:57-69`), and then ends the socket with a FIN (`lib/base/connection.js:1015-1026`). Destroy it before `end`: after `end`, the pool no longer removes it (`pool_connection.js:62-65`). |
| MariaDB    | mariadb 3.5.4                             | Each idle connection has sent COM_QUIT and destroyed its socket (`lib/pool.js:830-833`; `lib/cmd/quit.js:18-24`; `lib/connection.js:697-709`). Then it waits up to 10 s, every 100 ms, for the active connections, and destroys the rest (`lib/pool.js:852-866`). `end` removes all listeners of the pool (`lib/pool.js:851`). | None for one connection. For an idle connection, the end of `pool.end()` is the signal: its socket is destroyed before the promise resolves.                                                                                                    | `connection.destroy()` (`types/index.d.ts:142`). With no command in flight, it destroys the socket at once. With a command in flight, it sends `KILL <threadId>` on a second connection and then destroys the socket, with no event at the end (`lib/connection.js:731-800`).                                            |
| SQL Server | mssql 12.7.14, tedious 20.3.3, tarn 3.1.2 | `close()` destroys the tarn pool (`mssql/lib/base/connection-pool.js:602-644`). tarn waits for every used resource, with no limit (`tarn/dist/Pool.js:206-209`), and then destroys the free ones. mssql's destroyer resolves on the tedious `end` (`mssql/lib/tedious/connection-pool.js:159-191`).                            | The tedious `end` event (`tedious/lib/connection.d.ts:986-991`). `close()` destroys the socket at once (`tedious/lib/connection.js:1329-1333`) and emits `end` on the next tick (`:1195-1201`). Thus `close()` of mssql does not resolve early. | `connection.close()` of tedious on the resource that tarn's `acquireSuccess` gave, then `release(resource)` of the tarn pool (`tarn/README.md:106` and `:130-134`; `tarn/dist/Pool.js:132-144`). The tarn pool is `ConnectionPool.pool` (`@types/mssql/index.d.ts:258`).                                                 |

The pool events that the disposal reads:

- pg: `connect`, `acquire`, `release`, `remove` (`@types/pg/index.d.ts:238-242`; emitted at `pg-pool/index.js:337`, `:340`, `:389`, `:182`). The README of pg-pool documents only `error`, `connect` and `acquire` (`pg-pool/README.md:220-300`).
- mysql2: `connection`, `acquire`, `release` (`mysql2/promise.d.ts:97-99`).
- mariadb: `connection`, `acquire`, `release` (`mariadb/types/index.d.ts:278-281`; relayed at `lib/pool-promise.js:18-28`).
- mssql: tarn's `acquireSuccess`, `release` and `destroySuccess` (`tarn/README.md:130-145`), on `ConnectionPool.pool`, which exists only after `connect()` (`mssql/lib/base/connection-pool.js:521`).

A test can end a pool itself. pg-pool sets `ending` when `end()` starts and `ended` when its last client is gone (`@types/pg/index.d.ts:197-198`), and it rejects a second `end()` with "Called end on pool more than once" (`pg-pool/index.js:489-493`). A connection string overrides the `host` and the `port` of a pg config (`pg/lib/connection-parameters.js:57-61`), so a pool that goes through a proxy gets the handle's fields, not its connection string.

## Decision

1. **Each database handle gives `pool(options)`, typed as the driver's pool class.** `database()` and `start()` both return such a handle. The type does not hide `end`: the disposal waits for every client whatever the test does, so a test that ends a pool itself does no harm. The store of a product that tests `instanceof pg.Pool` takes the pool as it is.

   ```ts
   // @zukhruf/testing/postgres (pg)
   export type PostgresPoolOptions = Omit<
     pg.PoolConfig,
     'connectionString' | 'database' | 'user' | 'password'
   >;
   export interface PostgresDatabase extends Database {
     pool(options?: PostgresPoolOptions): pg.Pool;
   }
   // Postgres#database(): Promise<PostgresDatabase>; Postgres#start(): Promise<PostgresDatabase>
   ```

   The handle sets the database, the user and the password. The options cannot name another database or another user, so a pool of a handle is always a pool of that handle's database. The options set the rest, also the host and the port. Thus a test routes a pool through a proxy. `pool()` is synchronous. A call to `pool()` after the disposal started throws.

2. **`postgresPool(config)` of the `postgres` area builds one such pool for a test that has no handle**: a pool of another role, or a pool over a location that a test support receives as a string (mutex's subjects). It returns `{ pool: pg.Pool }` and the pool's disposal, which the test owns. The handle's `pool()` builds on it. The copy of mutex goes.

3. **The disposal of a pool ends the pool fully.** It tracks each client of the pool: the clients that connected (`connect`) and have not closed (`remove`), and the clients that are checked out now (`acquire`, `release`). It runs these steps:
   1. End the pool with `end()`, unless the pool is ending already (`pool.ending`). The idle clients close.
   2. Destroy each client that is checked out now, with `client.release(error)`. Count them.
   3. Wait until each client of the pool has sent `remove`.
   4. When step 2 destroyed a client, reject with an error that gives the count. A pool of `postgresPool` rejects from its own disposal.

4. **The disposal of the handle ends every pool of the handle, and only then drops the database.** `cleanup()` and `[Symbol.asyncDispose]` run the same steps:
   1. Stop new pools: `pool()` throws from now on.
   2. Dispose every pool of the handle at the same time.
   3. Drop the database (`database()`), or remove the container (`start()`), as before.
   4. When step 2 destroyed a client, throw an error that gives the count: "The disposal destroyed 1 client of a pool of this database that was still checked out." The database is dropped first, so a leak leaves no database for the run's reaper.

5. **The disposal does not wait for a checked-out client.** It has no grace period, no timer and no number. When a handle's disposal starts, each scope that the test opened after the handle has closed, because `await using` disposes in reverse order. No running code of the test holds a client then. A checked-out client is a leak: a broken store, or work that the test did not await. The disposal destroys it at once, so a broken store fails at its own claim's limit, the test's signal (`t.signal`, [ADR 0021](./0021-a-test-helper-in-the-test-support-of-three-packages-goes-into-an-area-when-no-public-package-does-its-work.md)), and the teardown adds no wait of its own. pg's `release()` is synchronous, so a correct store has given its client back when its own disposal resolved.

6. **`connectionString` stays on the handle**, with `host`, `port`, `user` and `password`. A child process or a worker thread opens its own pool from it, and never ends that pool: the pool ends with its process. The test declares the handle of the child after the database, so the child ends before the drop. A test of a store's own string path gives the store the string, and the store ends its own pool.

7. **The driver is an optional peer dependency of its area, with a static import**, as `mssql` already is of `sqlserver`: `pg` of `postgres`. A project that imports the `postgres` area installs `pg`.

### Next steps: MySQL, MariaDB and SQL Server

These are not built. Each one follows the Postgres shape: `pool(options)` typed as the driver's pool class, a disposal that tolerates a pool that the test ended already, the forced close and the socket-closed signal of the table above, and the drop after the last pool. The order is MySQL and MariaDB, then SQL Server.

```ts
// @zukhruf/testing/mysql (mysql2/promise)
export type MysqlPoolOptions = Omit<
  mysql.PoolOptions,
  'uri' | 'database' | 'user' | 'password'
>;
export interface MysqlDatabase extends MysqlFamilyDatabase {
  pool(options?: MysqlPoolOptions): mysql.Pool;
}

// @zukhruf/testing/mariadb (mariadb)
export type MariadbPoolOptions = Omit<
  mariadb.PoolConfig,
  'database' | 'user' | 'password'
>;
export interface MariadbDatabase extends MysqlFamilyDatabase {
  pool(options?: MariadbPoolOptions): mariadb.Pool;
}

// @zukhruf/testing/sqlserver (mssql)
export type SqlServerPoolOptions = Omit<
  sql.config,
  'server' | 'database' | 'user' | 'password' | 'authentication'
> & { server?: string };
export interface SqlServerDatabase extends Database {
  pool(options?: SqlServerPoolOptions): Promise<sql.ConnectionPool>;
}
```

`pool()` of `SqlServer` resolves once the pool is connected, as `new ConnectionPool(config).connect()` of mssql does, because the tarn pool, whose events the disposal reads, exists only then. `mysql2` and `mariadb` become optional peer dependencies of their areas.

## Considered Options

- **Keep the pool in each repository's test support** (mutex's `postgresPool`, with the lint ban on `new pg.Pool`: #3305, C4 and C5). Each repository keeps a copy of the same knowledge, three today, and a forgotten `await using` still compiles (#3305 review).
- **A pool typed without `end`** (`Omit<pg.Pool, 'end'>`, and the members that end the pools of the other drivers). It is not assignable to `pg.Pool`, so a product that tests `instanceof pg.Pool` cannot take it, and the disposal waits for every client anyway.
- **A listener that ignores the pool's errors** (`pool.on('error', () => {})`). It hides real errors, and it does not end the race (#3369).
- **A fixed grace period before the forced close**, for example 1 s, or the 10 s of mariadb's own `end()`. It is a wait with a number of its own, which [ADR 0021](./0021-a-test-helper-in-the-test-support-of-three-packages-goes-into-an-area-when-no-public-package-does-its-work.md) and [root ADR 0004](../../../../docs/adr/0004-a-library-that-waits-takes-the-clock-as-an-input.md) rule out for tests. By decision 5, no correct test needs it: it only makes a broken store fail later.
- **A disposal that only destroys a leaked client, and does not fail.** The leak of a broken store or of work that the test did not await then passes.
- **A signal for the wait**, `database({ signal: t.signal })`. When the test's signal aborts, the claim has already failed, so the forced close comes at the same time as with no wait. The signal adds an input for a wait that no correct test has.
- **End the sessions from the server**: `pg_terminate_backend` or `KILL` for each session of the pool before the drop. This is what `DROP … WITH (FORCE)` already does. The client then gets the error that this record removes.
- **Remove `connectionString`, or rename it.** A child process, a worker thread and a test of a store's string path need it.
- **A dynamic `import('pg')` in `pool()`.** It keeps the area free of `pg`, but `pool()` then returns a promise. No other area does it: `sqlserver` imports `mssql` statically.

## Consequences

- The race of #3305 cannot happen through a pool of a handle or of `postgresPool`. The drop runs only after each socket of each pool closed.
- A broken store that keeps a client fails at the claim's limit, and its teardown no longer hangs to the runner's limit (#3737 P1).
- A test that leaks a client now fails, also when its own assertions pass. When the test body threw too, the error of the test is the `suppressed` of a `SuppressedError`.
- After a forced close, a later `release()` of that client by the broken store throws "Release called on client which has already been released to the pool." in pg (`pg-pool/index.js:26-27`, `:373-375`).
- A project that imports `@zukhruf/testing/postgres` installs `pg`.
- A string still reaches `new pg.Pool` in a test's own process, and no type stops that. The lint ban on `new pg.Pool` in mutex's tests (`eslint.config.mjs`) stays, and points at `postgresPool` and `database.pool()`.
- MySQL and MariaDB do not end a session when its database is dropped (the drop has no FORCE: [mysql-family-collector.ts](../../src/databases/mysql-family-collector.ts)), so they have no 57P01. Their risk is a drop that waits for a session that has not closed. SQL Server ends the other sessions with `ROLLBACK IMMEDIATE` ([sqlserver-collector.ts](../../src/databases/sqlserver-collector.ts)). mssql's `close()` already waits for each socket of an idle connection, so its risk is only the checked-out connection, which makes `close()` wait with no limit.
- Then, in this order (#3759): MySQL and MariaDB, then SQL Server, then a release. deepagents #3369 then moves its `pool: <db>.connectionString` places to `pool: <db>.pool()`, factory #3370 moves, and #3305 closes.

## Open questions for the next steps

1. **Single connections.** A test also builds a `pg.Client`, a connection of `mysql.createConnection` or `mariadb.createConnection`, or a tedious `Connection`, for an admin session, an observer, or a store that opens one connection for each session. mutex's `SqlServerStore` subject builds no pool: it opens one tedious `Connection` for each session (`packages/mutex/src/testing/subjects/sqlserver.ts:33-74`). Does the handle own these connections too, for example with `connection(options)`?
2. **The forced close of mysql2.** `destroy()` ends the socket with a FIN (`lib/base/connection.js:1015-1026`), and the `end` event needs the server's FIN. Does MySQL close a session that waits in `GET_LOCK` when its client sends FIN? Reproduce it before the code. If it does not, the forced close runs `KILL CONNECTION <threadId>` through the client in the server's image, as the collector runs its SQL.
3. **The flavor of mysql2.** The proposal types the pool of `mysql2/promise`, which mutex uses. Is the callback pool of `mysql2` needed too?
4. **A pool that the test ended itself, for mysql2, mariadb and mssql.** pg exposes `ending`. Find the public signal of each other driver before its step.
