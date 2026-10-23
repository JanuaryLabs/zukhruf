# A database lock store takes its session from the caller

A database lock store needs a connection to its database. The app already has a driver, a pool, a connection string, TLS settings and credentials. A store that imports a driver would add a dependency to each user, and it would take the version of that driver from the app. Thus the caller gives the store a `connect` function, and the store gets each session from it. The store describes a session with a structural type: only the methods that it calls. The popular driver fits that type, and the store never imports the driver.

For `PostgresStore`, a session has `query(text, values)`, which resolves to `{ rows }`, `on('error' | 'end', listener)`, `off(event, listener)`, and `release(destroy)`. A `PoolClient` of `pg` (node-postgres) fits this type. This was proven with `tsc` in strict mode against `@types/pg` 8.23.1. `new PostgresStore({ connect: () => pool.connect(), sequence })` is the usual form.

The store owns each session that it gets. A session-level lock lasts as long as its session, and Postgres grants a lock again to a session that already holds it. Thus each held key has its own session, and a session holds at most one key. The callers of one key in one process line up in a queue in memory first, as in `SqliteStore`, so many waiters in one process use one session. A session that holds nothing goes back with `release()`. A session whose lock state is not known is destroyed with `release(true)`. The store always attaches its own `error` listener, because `pg.Pool` removes its own listener while a client is out of the pool, and an `error` with no listener stops the process.

Other libraries do the same. The dialects of Kysely take a pool that the caller made, not a connection string. DistributedLock (.NET) takes a connection string or a connection, and it prefers the connection string because a connection that the caller also uses can "be used in a way that disrupts the locking process".

## Considered Options

- **The store imports `pg`.** Each user of `@zukhruf/mutex/postgres` would get that version of `pg`, also when the app uses another version or another driver. The store would also have to take each connection setting.
- **A connection string.** The store would then make its own pool. It would need a driver, and it would repeat the settings that the app already has: TLS, credentials, keep-alive.
- **One session that the caller gives.** The caller could use the same session for other queries. A `DISCARD ALL` or a pool release of that session would release the locks. The waits of many keys would also wait one behind the other on one session.
- **One session for all keys of the store.** Postgres grants a lock again to a session that holds it. If two keys had the same number, the second key would be granted while the first key is held, and two holders would run. One session can also run only one query at a time, so a waiter would block the other keys.
- **A full driver interface, for example with transactions.** The store needs only four methods. A smaller type fits more drivers and wrappers.

## Consequences

- The package has no dependency on a Postgres driver. `pg` is a dev dependency for the tests only.
- `@zukhruf/mutex/postgres` gives `PostgresStore` and the type of its session ([ADR 0020](./0020-each-store-family-has-its-own-import-path.md)).
- The pool of the caller must have room for one session for each key that the process holds or waits for, and for one session for a holder check. A cancel needs no session ([ADR 0023](./0023-a-postgres-waiter-is-cancelled-by-closing-its-session.md)).
- The caller sets the client settings that the store cannot set: `keepAlive: true`, and no `query_timeout`. The store sets the server settings that it needs, `statement_timeout` and `lock_timeout`, on its own session, and resets them before it gives the session back. See [PostgresStore](../stores/postgres-store.md#failure-modes).
- A driver that does not fit the type needs a small wrapper that the caller writes.
