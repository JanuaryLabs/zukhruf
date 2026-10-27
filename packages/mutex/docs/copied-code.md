# Code that is in two places

This repository follows the Rule of Three, and it counts places, not packages. The first place writes the code. A second place copies it, and a note records the copy. A third place extracts the code to one home, and the copies go. Thus the boundary of the shared code comes from three working copies, not from a guess.

This note records the code that is in two places inside the mutex. While both places exist, a fix to one place goes into the other place too, and the commit names both files. A third place is the time to extract the code. The last two sections record the code and the test helpers that are in more than two places.

The paths are in `packages/mutex/src/lock-stores`. The code that the single flight copied from the mutex has [its own note](../../single-flight/docs/copied-from-mutex.md).

## In two places

**A connector that gives its one connection once.**

- Places: `ParentPortConnector` in `thread/thread-store.ts`, and `ProcessChannelConnector` in `ipc/ipc-store.ts`.
- Same: each connector keeps its one connection in an iterator. The first `connect` gives the connection. Each later `connect` gives `undefined`: the coordinator is gone, and nothing can replace it.
- Differs: the IPC connector first checks `process.connected`. When the channel to the parent closed, it gives `undefined` at once. A worker's port lasts as long as the worker, so the thread connector has no such check.

**Listeners only while the connection is referenced.**

- Places: `ref`, `unref` and `close` of `ParentPortConnection` (`thread/parent-port-connection.ts`) and of `ProcessChannelConnection` (`ipc/process-channel-connection.ts`).
- Same: `ref` calls `stopListening` and then `listen`, so a second `ref` does not listen twice. `unref` calls `stopListening`. `close` calls `unref`.
- Differs: only the events that tell that the peer is gone. The process channel gives `disconnect` to `SharedChannelConnection` (`remote/shared-channel-connection.ts`). The port gives no event, because the coordinator cannot stop while its workers run.

**Listeners from the start until `close`.**

- Places: the constructor, `ref`, `unref` and `close` of `WorkerConnection` (`thread/worker-connection.ts`) and of `ChildProcessConnection` (`ipc/child-process-connection.ts`).
- Same: the constructor calls `listen`. `ref` and `unref` do nothing, because the peer keeps this process alive while it runs. `close` calls `stopListening`.
- Differs: the event that tells that the peer is gone: `exit` of the worker, or `disconnect` of the child.

Backlog #2544 is about this code: `close` stops the listeners, but it does not emit `close`. A fix for it goes into both places.

**The message of a closed client.**

- Places: `close` and `#assertUsable` of `RemoteLockClient` (`remote/remote-lock-client.ts`).
- Same: the text `'This lock client is closed.'`.
- Differs: `close` rejects each request that waits for its answer. `#assertUsable` throws for a request that comes after `close`.

**The options of the two coordinators.**

- Places: `ThreadLockCoordinatorOptions` and the constructor of `ThreadLockCoordinator` (`thread/thread-lock-coordinator.ts`), and `IpcLockCoordinatorOptions` and the constructor of `IpcLockCoordinator` (`ipc/ipc-lock-coordinator.ts`).
- Same: one optional `tokens` option with the same comment, and the default `new CounterTokenSource()`. The constructor makes a `LockCoordinator`, gives it to `DelegatingLockStore`, and keeps it for `adopt`.
- Differs: only the names, and the connection that `adopt` makes: a `WorkerConnection` or a `ChildProcessConnection`.
- Not counted: `MemoryStore` (`memory/memory-store.ts`) has the same default `tokens`, but no other part of this code. It grants keys itself, with no coordinator and no `adopt`. Each lock store sets the default token source for its own reach ([the table in Fencing tokens](./concepts/fencing-tokens.md)). Thus a change to the default of one reach does not change the default of another reach.

**The forwarders of a lock store.**

- Places: `DelegatingLockStore` (`remote/delegating-lock-store.ts`), and `SocketStore` (`socket/socket-store.ts`).
- Same: `acquire`, `tryAcquire` and `isHeld` give each call to the lock store that does the work.
- Differs: `SocketStore` gives each call to its own `RemoteLockClient`. It extends `EventEmitter` for its role events, and a class has only one base class, so it cannot extend `DelegatingLockStore`. A new operation of `LockStore` goes into both places, as `isHeld` did in fb6456b.

**The second check under the reclaim lock.**

- Places: `#evictIfGone` of `LockFileStore` (`file-system/lock-file-store.ts`), and `#evictGoneHeads` of `TicketQueueFileStore` (`file-system/ticket-queue-file-store.ts`).
- Same: `Presence.judge` found the caller gone. Under the reclaim lock, the lock store reads the record again. When the record does not name that caller now, another waiter evicted it first, and the lock store stops. Otherwise the lock store removes the caller from the record, and then deletes the presence file of the caller.
- Differs: `LockFileStore` deletes the lock file. `TicketQueueFileStore` writes the other tickets back, and then does the same for the next ticket while its caller is gone too.

**The longest suffix of the two file stores.**

- Places: `longestSuffix` of `LockFileStore` and of `TicketQueueFileStore`.
- Same: `Math.max(Presence.suffixLength, draftSuffixLength)`.
- Differs: only the comment. In `LockFileStore`, `createExclusive` writes the draft. In `TicketQueueFileStore`, `atomicWrite` writes it.
- Not counted: `SqliteStore.longestSuffix` (`sqlite/sqlite-store.ts`) is `'-journal'.length`. It keeps the file names that published versions gave the keys, so it does not come from the files that the lock store makes.

**The read of one JSON line.**

- Places: the `line` listener in the constructor of `SocketConnection` (`socket/socket-connection.ts`), and `parse` in `socket/handshake.ts`.
- Same: `JSON.parse` of one line of the socket's newline-delimited JSON. The write side is in one place already: `jsonLine` (`socket/json-line.ts`).
- Differs: a line that is not JSON. `SocketConnection` closes the connection, because the framing is broken ([ADR 0017](./adr/0017-a-connection-closes-only-when-its-framing-breaks.md)). `parse` gives `undefined`, and the handshake reads that as no `hello` or no answer.

**The listeners that come off a session that goes back to its pool.**

- Places: `detach` of the Postgres dialect (`postgres/postgres-store.ts`), and of the `GET_LOCK` dialect of MySQL and MariaDB (`mysql/get-lock-dialect.ts`).
- Same: `off('error', …)` and `off('end', …)` with the two listeners of the session core (`session/session-lock-store.ts`).
- Differs: nothing but the type of the session. The SQL Server dialect does nothing in `detach`: it closes each session, and a closed session keeps its listeners, because a driver can emit `error` after the close.

Backlog #2899 is about this code. A third dialect with a pool is the time to move it into the session core.

**Not counted: the lifecycle of a Docker engine claim.** `Claim` of `DockerEngineStore` (`docker/docker-engine-store.ts`) has a heartbeat, a lost lease, and a release, as the key session of the session core has. But a claim is a container, not a session: it attaches, it climbs a ladder for its token, and a waiter can remove it. Thus it differs in kind, and it stays in its store. It uses only the in-process turn (`shared/in-process-turns.ts`) and the key digest (`shared/key-digest.ts`).

**The worker thread of the cross-thread tests.**

- Places: `threadSource` and `startThread` in `packages/mutex/src/mutex/is-held.test.ts` and in `packages/mutex/src/mutex/mutex.test.ts`.
- Same: `threadSource` gives the source of a worker. The worker imports `Mutex` and the store cases with dynamic imports, makes the thread side of the store, and runs `body`. `startThread` starts an eval worker with that source, and the host adopts the worker before it can ask for a key.
- Differs: nothing in the code. One comment breaks its lines in a different place.
- Why it stays: this knowledge is only in this repository, and no package exports a shared test module. Only a test helper whose knowledge is in three or more repositories goes into `@zukhruf/testing` ([testing ADR 0016](../../testing/docs/adr/0016-a-test-helper-goes-into-an-area-when-three-repositories-have-its-knowledge-and-it-does-not-use-mock.md)).

**The magic numbers of the network file systems.**

- Places: `networkFileSystems` in `packages/mutex/src/lock-stores/network-directory.test.ts`, and in `packages/fs/src/local-directory.test.ts`.
- Same: the 13 pairs of a name and the `f_type` that the `statfs` of Linux gives for that network file system, from NFS (`0x6969`) to 9p (`0x01021997`). Each test file makes a test for each pair.
- Differs: nothing in the code.
- Why it stays: this knowledge is only in this repository, and no package exports a shared test module. `linuxNetworkFileSystems` in `packages/fs/src/local-directory.ts` has the same numbers, but it is the code under test. A test that imports that table cannot find a wrong number in it. Thus each test file keeps its own table.

Three more test helpers of the mutex are also in other packages. `mountAs` and `LosableElection` are in three places, and [the ledger of the election](../../election/docs/copied-code.md#test-helpers-in-more-than-two-places) records them. `listening` is in two places, and [the note of the single flight](../../single-flight/docs/copied-from-mutex.md#tests-copied) records it.

## In more than two places

The Rule of Three asks to extract the code below. It is not extracted yet. Until it is, a fix to one place goes into each place, and the commit names each file.

**The map of the requests that wait for an answer.** Three places.

- Places: `#take` and `#rejectAll` of `RemoteLockClient` (`remote/remote-lock-client.ts`), `#take` and `rejectAll` of `Queries` (`remote/queries.ts`), and `#take` of `FlightClient` (`packages/single-flight/src/client/flight-client.ts`).
- Same: a map of requests by id. An entry keeps only what settles the caller's promise. `#take` gets an entry, deletes it, and tells its owner that the map changed, so the owner can `ref` or `unref` its connection. A reject-all takes each entry and rejects it.

The maintainer chose to keep the three places (backlog #2538). The parts that are the same are short, and the parts that differ (the delivery states, what a new connection sends again, what keeps the process alive) stay with each owner. A fourth place, or the coordinator package of backlog #2496, is the time to extract it.

## Test helpers in more than two places

The tests of the lock stores that use a database server have four helpers in more than two places. Root ADR 0001 (rule 2) keeps test helpers as copies, also after the third copy. A test helper goes into `@zukhruf/testing` only when three or more repositories have its knowledge and it does not use the `mock` of `node:test` ([testing ADR 0016](../../testing/docs/adr/0016-a-test-helper-goes-into-an-area-when-three-repositories-have-its-knowledge-and-it-does-not-use-mock.md)). The knowledge of these four helpers is only in this repository. Also, no package exports a shared test module, and each test file reads from top to bottom. Thus each helper stays a copy. A fix to one place goes into each place, and the commit names each file.

The paths are in `packages/mutex/src`.

**`hold`.** Six places.

- Places: `mutex/acquire-modes.test.ts`, `lock-stores/postgres/postgres-store.test.ts`, `lock-stores/mysql/mysql-store.test.ts`, `lock-stores/mariadb/mariadb-store.test.ts`, `lock-stores/sqlite/sqlite-store.test.ts` and `lock-stores/docker/docker-engine-store.test.ts`.
- Same: `hold` acquires a key with a `Mutex`, and keeps the key until the test calls the release. It gives control back when the work of the lock starts.
- Differs: the first four places are byte-identical, and they give `{ release }`. The SQLite copy gives the release function itself. The Docker copy also gives the fencing token of the lease, and it rejects when the acquire fails.

**`untilASessionWaitsForALock`.** Four places.

- Places: `lock-stores/postgres/postgres-store.test.ts`, `lock-stores/mysql/mysql-store.test.ts`, `lock-stores/mariadb/mariadb-store.test.ts` and `lock-stores/sqlserver/sqlserver-store.test.ts`.
- Same: `t.waitFor` with an interval of 10 ms and a timeout of 10 s, until the server shows a session that waits for a lock.
- Differs: the view of each server. Postgres reads `pg_stat_activity`, MySQL and MariaDB read `information_schema.PROCESSLIST` for the state `User lock`, and SQL Server reads `sys.dm_tran_locks`. The SQL Server copy uses the `observe` helper of its file, and does not open its own connection. MySQL and MariaDB differ only in the driver.

**`proxyTo`.** Four places.

- Places: `lock-stores/postgres/postgres-store.test.ts`, `lock-stores/mysql/mysql-store.test.ts`, `lock-stores/mariadb/mariadb-store.test.ts` and `lock-stores/sqlserver/sqlserver-store.test.ts`.
- Same: a TCP proxy on `127.0.0.1` to the database server. `partition` stops each byte in both directions and keeps the sockets open, as a network partition does. The disposal destroys the sockets and closes the server.
- Differs: the input and the output. The Postgres copy takes a connection string and gives one back. The MySQL and MariaDB copies take the database and give the port. They differ only in the type of the database. The SQL Server copy takes an `Endpoint`, and gives the host and the port.

**`silentlyReconnectingSession`.** Three places.

- Places: `lock-stores/postgres/postgres-store.test.ts`, `lock-stores/mysql/mysql-store.test.ts` and `lock-stores/sqlserver/sqlserver-store.test.ts`.
- Same: a session that opens a new connection when the server ends its connection, and does not tell the lock store: no `error` and no `end`. A query that fails on the ended connection runs again on the new connection. Queries on the new connection wait until the test calls `resume`. Thus the test decides when the lock store sees the new connection.
- Differs: the driver and the type of the session. Each copy gives the id of the first connection: `pid` for Postgres, `id` for MySQL and SQL Server.
