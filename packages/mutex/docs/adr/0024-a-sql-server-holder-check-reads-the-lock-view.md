# A SQL Server holder check reads the lock view

A holder check never acquires the key ([ADR 0015](./0015-a-holder-check-never-acquires-the-key.md)). `SqlServerStore` holds a key with a session-owned application lock of SQL Server. SQL Server has a function for this question: `APPLOCK_TEST`. Its [documentation](https://learn.microsoft.com/sql/t-sql/functions/applock-test-transact-sql) says that it tells "whether or not a lock can be granted ... without acquiring the lock". A probe showed that this is not true inside the server. An Extended Events session recorded a `lock_acquired` event with mode `X` on the `APPLICATION` resource for each `APPLOCK_TEST` on a free key, on Azure SQL Edge 15.0 and on SQL Server 2022. The lock lasts for an instant: in 166,170 calls from 12 sessions, 3,784 tries of the free key by another session never got `-1`. But the server takes the lock that callers of `acquire` and `tryAcquire` need, and ADR 0015 forbids this.

Thus the holder check of `SqlServerStore` reads the lock view `sys.dm_tran_locks`. It counts a row with `resource_type` equal to `APPLICATION`, the current database, and `request_status` equal to `GRANT`. A read of a view takes no application lock. The view shows a name as `<principal ID>:[<first 32 characters>]:(<hash>)`. Thus the store makes a name of exactly 32 hex characters for each key: the first 16 bytes of the SHA-256 digest of the key. The holder check compares the full name, with no prefix match.

## Considered Options

- **`APPLOCK_TEST`.** It needs no permission beyond the database. But it acquires the lock for an instant, as the trace shows. No test from outside found a busy answer, so the cost is not visible today. ADR 0015 is a rule about what the check takes, not only about what callers see. `APPLOCK_TEST` also answers "free" in the session of the holder, because SQL Server grants the lock again to that session.
- **A name of 64 hex characters, the full SHA-256 digest.** The view shows only the first 32 characters. The holder check would then compare a prefix, and another application lock in the database whose name starts with the same 32 characters would count as a holder.
- **A `tryAcquire` and a release.** ADR 0015 rejected this for all lock stores.

## Consequences

- The role of the app needs `VIEW SERVER STATE` on SQL Server 2019 and earlier, or `VIEW SERVER PERFORMANCE STATE` on SQL Server 2022, to run a holder check. Without it, `isHeld` rejects with error 300. `acquire` and `tryAcquire` do not need it.
- `VIEW SERVER STATE` also shows the sessions and requests of other databases on the server. An app that cannot get it cannot use holder checks with `SqlServerStore`.
- A key and its lock name have a 128-bit link. Two keys share a lock only if the first 16 bytes of their digests are the same.
- The holder can change before the answer arrives. Show the answer, but do not acquire a key because of it.
