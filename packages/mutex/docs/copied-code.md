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

**A presence that outlasts its record.**

- Places: `Presence` (`file-system/presence.ts`: `claim`, `releaseAfter`), and `SessionDirectory.record` with `SessionRecord` (`socket/session-directory.ts`).
- Same: a caller takes a `FileLock` on a file of its own before its record appears. To leave, it removes its record first, then frees the lock, then deletes the presence file. A reader that finds the record and a free presence knows that the caller stopped ([ADR 0012](./adr/0012-a-file-store-holder-is-judged-by-its-presence.md)).
- Differs: a session of a socket store has its own names, `sessions/<id>.json` and `sessions/<id>.presence`, and a record of its own content, so it cannot use the paths of `Presence`. A new leader also deletes a presence file that has no record and no lock, under its own lock, so a session that finds its locked file gone takes its presence again ([ADR 0033](./adr/0033-a-new-leader-grants-nothing-until-each-recorded-session-reasserted-its-keys-stopped-or-missed-its-lease.md)). `Presence` is never deleted by another caller before its record exists.

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

**The magic numbers of the network file systems.**

- Places: `networkFileSystems` in `packages/mutex/src/testing/network-mount.ts`, and in `packages/fs/src/local-directory.test.ts`.
- Same: the 13 pairs of a name and the `f_type` that the `statfs` of Linux gives for that network file system, from NFS (`0x6969`) to 9p (`0x01021997`). Each test file makes a test for each pair.
- Differs: nothing in the code.
- Why it stays: this knowledge is only in this repository, and no package exports a shared test module. `linuxNetworkFileSystems` in `packages/fs/src/local-directory.ts` has the same numbers, but it is the code under test. A test that imports that table cannot find a wrong number in it. Thus each test file keeps its own table.

**The tickets in a queue file (test helper).**

- Places: `ticketsIn` in `file-system/presence.test.ts` and in `file-system/ticket-queue-file-store.test.ts`.
- Same: each helper reads the queue file and counts its tickets.
- Differs: the copy in `presence.test.ts` gives 0 for a missing file, and counts line ends. The copy in `ticket-queue-file-store.test.ts` throws an error for a missing file, and counts lines that are not empty.

**The published socket path (test helper).**

- Places: `publishedSocketPath` in `socket/socket-store-coordinator.test.ts` and in `socket/socket-store-reconnect.test.ts`.
- Same: nothing differs.
- Not counted: `PipeEndpoint` of `@zukhruf/pipes` makes the path that the store uses, and it is the code under test. `pipeFor` in `socket/wire-compatibility.test.ts` spells out the published name, because that test pins it.

**The file stores of a test (test helper).**

- Places: `stores` in `file-system/presence.test.ts` and in `file-system/reclaim-lock.test.ts`.
- Same: the name, the URL and the `create` function of `LockFileStore` and of `TicketQueueFileStore`.
- Differs: `reclaim-lock.test.ts` adds `evictionStep`.
- Not counted: `stores` in `file-system/containers.test.ts` holds only the names, because its stores run in a container.

**The skip outside POSIX (test helper).**

- Places: `posixOnly` in `file-system/presence.test.ts` and in `sqlite/sqlite-store.test.ts`.
- Same: each helper skips a test on Windows.
- Differs: the reason of the skip.

**The helpers of the MariaDB and MySQL subjects (test helper).**

- Places: `packages/mutex/src/testing/subjects/mariadb.ts` and `packages/mutex/src/testing/subjects/mysql.ts`.
- Same: three blocks, byte for byte: the store with its disposal, `silentlyReconnectingSession`, and `watched` of `sessionControl`. The MySQL subject also uses the `mariadb` driver in these blocks.
- Differs: the imports, the fixture, and the pool of each driver.

**The test of a user with few grants.**

- Places: `mariadb/mariadb-store.test.ts` and `mysql/mysql-store.test.ts`.
- Same: the act and the assert. The token is 1 for a user that has only the grants that the store page names.
- Differs: the grants. MariaDB gives `SELECT` and `INSERT` on the sequence. MySQL gives `SELECT` and `UPDATE` on the token table.

**The connection of a SQL Server session (test helper).**

- Places: `sessionTo` in `sqlserver/sqlserver-store.test.ts`, and `sqlServerSession` in `packages/mutex/src/testing/subjects/sqlserver.ts`.
- Same: the `Connection` of `tedious` with its options, and the session that wraps it.
- Differs: the names, and the source of the host and the user: an endpoint and a database, or a server.

**The arrange step of a look at a holder in another process or thread.**

- Places: `packages/mutex/src/testing/contract/on-disk.ts`, `packages/mutex/src/testing/contract/processes.ts` and `thread/thread-store.test.ts`.
- Same: a fixture, a host, and a holder that takes the key. These lines are the arrange step of each test.
- Why it stays: each test has its own arrange step, and a test has no lifecycle hooks. Thus the Rule of Three does not ask to extract these lines.

**Not counted: test helpers with one name and different knowledge.** Each of these has its name in three or more places, but each place holds other knowledge. Thus they stay with each test.

- `holderSource`: each child process holds a key of another lock store, in another place. One runs in a container, and one has no `Mutex`.
- `storeOver`, `storeOn`, `sessionControl`, `poolControl`, `poolOf` and `silentlyReconnectingSession`: each one uses the driver of its server. The MariaDB and MySQL subjects are the exception: see [the helpers of the MariaDB and MySQL subjects](#in-two-places).
- `heartbeatInterval`, `sequence` and `image`: each test file sets the value for its own test.
- `askLeader` in `socket/handshake.test.ts`, `publishedPeer` in `socket/wire-compatibility.test.ts` and `rawPeer` in `socket/socket-store-coordinator.test.ts`: each client keeps another thing, and only `rawPeer` does the handshake.
- `outcomeOf` in `docker/docker-engine-store.test.ts`: it also reports a promise that did not settle.

Three more test helpers of the mutex are also in other packages. `mountAs` and `LosableElection` are in three places, and [the ledger of the election](../../election/docs/copied-code.md#test-helpers-in-more-than-two-places) records them. `listening` is in two places, and [the note of the single flight](../../single-flight/docs/copied-from-mutex.md#tests-copied) records it.

**The codes of a Windows refusal.**

- Places: `isRefusedForNow` in `packages/fs/src/patiently.ts` (not exported), and `isRefusedByWindows` in `sqlite/holder-record.ts`.
- Same: the error is a refusal only on `win32`, with the code `EPERM`, `EACCES` or `EBUSY`, read with `isErrno` (ADR 0011 of `@zukhruf/fs`).
- Differs: `patiently` retries the refused operation for a while; `#clearEarlierHolders` leaves the refused delete for the next holder, so the grant never fails on it.

Backlog #4919 extracts the predicate at a third place.

## In more than two places

The Rule of Three asks to extract the code below. It is not extracted yet. Until it is, a fix to one place goes into each place, and the commit names each file.

**The warning of a failure that no caller hears.** Ten places, kept by the maintainer (#3619, backlog #4938).

- Places: `#freeLost` of `Term` (`packages/election/src/term.ts`), `giveBack` (`packages/mutex/src/mutex/mutex.ts`), `#removeLost` of the docker lock store (`docker/docker-engine-store.ts`), `ref` of the shared connection (`packages/ssh/src/control/shared-connection.ts`), the draft removal of `createExclusive` (`packages/fs/src/create-exclusive.ts`), the scheduled measurement and the exit handler of the CO₂ tracker (`packages/mteb/src/dependencies/codecarbon.ts`), the unheard error events of the SQLite queue (`packages/sqlite/queue/src/index.ts`, `timekeeper.ts`), and `warn` of `PoolWorkers` for a background failure of its store (`packages/pool/src/pool-workers.ts`).
- Same: `process.emitWarning(Error.isError(error) ? error : new Error(String(error), { cause: error }))`: the failure goes to the process, which keeps running.
- Differs: the exit handler of the CO₂ tracker uses `process.emit('warning', …)`, because the next tick of `emitWarning` never runs at exit; `PoolWorkers` names the expression `warn(error)`, a function of its own file.

The maintainer chose the copies over a shared helper on 2026-11-20. A fix to the expression goes into each place.

**The map of the requests that wait for an answer.** Three places.

- Places: `#take` and `#rejectAll` of `RemoteLockClient` (`remote/remote-lock-client.ts`), `#take` and `rejectAll` of `Queries` (`remote/queries.ts`), and `#take` of `FlightClient` (`packages/single-flight/src/client/flight-client.ts`).
- Same: a map of requests by id. An entry keeps only what settles the caller's promise. `#take` gets an entry, deletes it, and tells its owner that the map changed, so the owner can `ref` or `unref` its connection. A reject-all takes each entry and rejects it.

The maintainer chose to keep the three places (backlog #2538). The parts that are the same are short, and the parts that differ (the delivery states, what a new connection sends again, what keeps the process alive) stay with each owner. A fourth place, or the coordinator package of backlog #2496, is the time to extract it.
