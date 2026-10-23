# A MySQL-family lock belongs to one database

`MysqlStore` and `MariadbStore` use user locks: `GET_LOCK`, `RELEASE_LOCK` and `IS_USED_LOCK`. A user lock of MySQL and MariaDB belongs to the whole server, not to one database. In a probe on MySQL 9.7.4 and on MariaDB 12.3.3, a session in one database held the name `scope`. Then `GET_LOCK('scope', 0)` of a session in another database gave `0`.

The fencing tokens of these stores come from one database: the token table of `MysqlStore`, or the sequence of `MariadbStore`. Thus the lock must belong to the same database as its token source. If two stores in two databases shared one lock, they would get their tokens from two counters. A later holder could then get a smaller token than an earlier holder. A fenced resource would accept the writes of the earlier holder after the later one, and [ADR 0003](./0003-a-fencing-token-on-every-lease.md) would not hold.

Thus the server makes the name of each lock from the database of the session and the key:

```sql
SHA2(CONCAT(DATABASE(), ':', ?), 256)
```

The client sends `?`: the SHA-256 digest of the UTF-16 code units of the key, as 64 lowercase hex characters. The UTF-16 code units, not UTF-8, so that two keys that differ only in a lone surrogate get two digests. `GET_LOCK`, `RELEASE_LOCK` and `IS_USED_LOCK` all use this name. The result has 64 lowercase hex characters:

- MySQL takes names of at most 64 characters, and MariaDB takes at most 192.
- MySQL compares names without case, and MariaDB compares them with case. Lowercase hex is the same under both rules.

This is the reach of `PostgresStore`: a Postgres advisory lock also belongs to one database. Each process on each machine that reaches one database shares each key. This is the network reach of [ADR 0021](./0021-a-lock-store-can-reach-every-machine-that-reaches-one-server.md).

## Considered Options

- **The key alone, for the whole server.** The client would send only the digest of the key. Two databases on one server would share each key, but each database has its own token source. The tokens of one key would then not increase across holders, so ADR 0003 would not hold. Also, the tests of the shared lock-store suite use fixed keys, and each test gets a new database on one shared server. Tests that run at the same time would share their locks.
- **The database name in the digest on the client.** The store would read `DATABASE()` once and hash it with the key. But a caller can change the database of a pooled session. The name that the server makes in each statement always follows the database of the statement.
- **The key as the name.** A key longer than 64 characters fails on MySQL with `User-level lock name ... should not exceed 64 characters`. On MySQL, two keys that differ only in case would be one lock.

## Consequences

- Two apps on one server that use two databases never share a key. Two apps that use one database share each key, as with `PostgresStore`.
- A session with no database makes the name `NULL`. MySQL then fails each lock function with `ER_USER_LOCK_WRONG_NAME`. MariaDB gives `NULL`, and the store fails the call: `GET_LOCK` that gives `NULL` is an error, and the holder check fails when `DATABASE()` is `NULL`.
- Do not change the database of a session that the store holds, for example with `USE`. The `RELEASE_LOCK` would then make another name and release nothing. The store would then see the failed release, lose the lease, and close the session.
- A key never collides with another key in one database, unless SHA-256 collides. A `PostgresStore` key uses 64 bits of the digest, so two keys can share one lock there. Here they cannot.
