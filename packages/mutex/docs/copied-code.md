# Code that is in two places

This repository follows the Rule of Three, and it counts places, not packages. The first place writes the code. A second place copies it, and a note records the copy. A third place extracts the code to one home, and the copies go. Thus the boundary of the shared code comes from three working copies, not from a guess.

This note records the code that is in two places inside the mutex. While both places exist, a fix to one place goes into the other place too, and the commit names both files. A third place is the time to extract the code. The last two sections record the code and the test helpers that are in more than two places.

The paths are in `packages/mutex/src/lock-stores`. The code that the single flight copied from the mutex has [its own note](../../single-flight/docs/copied-from-mutex.md).

## In two places

**The rounds of a contention test, by the store's grant time.**

- Places: `increments` of 'four processes incrementing a shared counter never lose an update' (`testing/contract/processes.ts`), and `roundsOf` in `testing/contract/threads.ts`, which two tests of that file use: `incrementFromFourThreads` (at most 20) and 'looks from another thread never make a caller that skips if busy give up on a free key' (at most 50). Three places, so the rule is due for extraction (#6296); it waits until `processes.ts` has no uncommitted edits of another session.
- Same: as many rounds as about 2 s of grants at `grantLatency`, at least 6 and at most the old count; each contender first takes a warm-up key, and all start their rounds together.
- Differs: the processes test allows at most 25 rounds and starts the processes with an IPC ready/go; the threads test allows at most 20 and starts the threads with `Atomics.waitAsync` on shared memory.
- Until a third place needs it, a fix in one goes into the other, and the commit names both files.

**A connector that gives its one connection once.**

- Places: `ParentPortConnector` in `thread/thread-store.ts`, and `ProcessChannelConnector` in `ipc/ipc-store.ts`.
- Same: each connector keeps its one connection in an iterator. The first `connect` gives the connection. Each later `connect` gives `undefined`: the coordinator is gone, and nothing can replace it.
- Differs: the IPC connector first checks `process.connected`. When the channel to the parent closed, it gives `undefined` at once. A worker's port lasts as long as the worker, so the thread connector has no such check.

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
- Same: `CallerPresence.judge` found the caller gone. Under the reclaim lock, the lock store reads the record again. When the record does not name that caller now, another waiter evicted it first, and the lock store stops. Otherwise the lock store removes the caller from the record, and then deletes the presence file of the caller.
- Differs: `LockFileStore` deletes the lock file. `TicketQueueFileStore` writes the other tickets back, and then does the same for the next ticket while its caller is gone too.

**The longest suffix of the two file stores.**

- Places: `longestSuffix` of `LockFileStore` and of `TicketQueueFileStore`.
- Same: `Math.max(CallerPresence.suffixLength, draftSuffixLength)`.
- Differs: only the comment. In `LockFileStore`, `createExclusive` writes the draft. In `TicketQueueFileStore`, `atomicWrite` writes it.
- Not counted: `SqliteStore.longestSuffix` (`sqlite/sqlite-store.ts`) is `'-journal'.length`. It keeps the file names that published versions gave the keys, so it does not come from the files that the lock store makes.

**The read of one JSON line.**

- Places: the `line` listener in the constructor of `SocketConnection` (`socket/socket-connection.ts`), and `parse` in `socket/handshake.ts`.
- Same: `JSON.parse` of one line of the socket's newline-delimited JSON. The write side is in one place already: `jsonLine` (`socket/json-line.ts`).
- Differs: a line that is not JSON. `SocketConnection` closes the connection, because the framing is broken ([ADR 0017](./adr/0017-a-connection-closes-only-when-its-framing-breaks.md)). `parse` gives `undefined`, and the handshake reads that as no `hello` or no answer.

**The listeners that come off a session that goes back to its pool.**

- Places: `detach` of the Postgres dialect (`postgres/postgres-store.ts`), and of the `GET_LOCK` dialect of MySQL and MariaDB (`mysql/get-lock-dialect.ts`).
- Same: `off('error', …)` and `off('end', …)` with the two listeners of the session core (`session/session-lock-store.ts`).
- Differs: nothing but the type of the session.

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

**The keep-alive byte of a holder on a Docker engine.** Three places in two packages, as copies by the owner's choice ("All three, as copies", root ADR 0012, #5543); the extraction waits for his go (#5575). The note of `@zukhruf/testing` records them ([copied-code.md](../../testing/docs/copied-code.md)). The place in this package is `claimCommand` and `drained` in `docker/docker-engine-store.ts`.

**The class of a warning of a failure that no caller hears.** Thirteen places, one class for each type, by the maintainer's choice (#3619, backlog #4938; the shape of root ADR 0010, #5472; a class for each type, root ADR 0011, #5474).

- Places: `TermWarning` (`packages/election/src/term-warning.ts`), `CreateExclusiveWarning` (`packages/fs/src/create-exclusive-warning.ts`), `PeriodicSchedulerWarning` (`packages/mteb/src/dependencies/periodic-scheduler-warning.ts`), `LockWarning` (`packages/mteb/src/dependencies/lock-warning.ts`), `LeaderSelectorWarning` (`packages/election/src/leader-selector-warning.ts`), `MutexWarning` (`packages/mutex/src/mutex/mutex-warning.ts`), `DockerEngineStoreWarning` (`docker/docker-engine-store-warning.ts`), `LockServerWarning` (`socket/lock-server-warning.ts`), `PoolWarning` (`packages/pool/src/pool-warning.ts`), `SqliteJobQueueWarning` (`packages/sqlite/queue/src/sqlite-job-queue-warning.ts`), `TimekeeperWarning` (`packages/sqlite/queue/src/timekeeper-warning.ts`) `SharedConnectionWarning` (`packages/ssh/src/control/shared-connection-warning.ts`) and `ServerWarning` (`packages/rpc/src/error/server-warning.ts`).
- Same: a class that `extends Error`, with a literal `code`, a `detail` from its subject, and ``super(`<what failed>, and <what next>: ${Error.isError(failure) ? failure.message : String(failure)}`, { cause: failure })``: the failure goes to the process, which keeps running, as the `cause` of a warning with its own type, code and subject. Each site emits `process.emitWarning(new <Type>Warning(error, subject))`. `zukhruf/require-warning-code` of `@zukhruf/eslint` holds each `emitWarning` place to a code, and refuses the `Object.assign(…)` form.
- Differs: the message, the name, the code and the subject of each class; `PoolWarning` and `SqliteJobQueueWarning` take the code in their subject, and the code sets the message; the exit handler of the CO₂ tracker emits its `LockWarning` with `process.emit('warning', …)`, because the next tick of `emitWarning` never runs at exit, so the lint rule does not see it.

The maintainer chose the copies over a shared helper on 2026-11-20, and again on 2026-11-24 ("Inline now, file the helper"). On 2026-11-24 he chose a class for each type over a helper: "I don't like the warning abstraction. instead of we should have own class that each place does like process.emitWarning(new class)". A fix to the shape goes into each class.

## Moved to `@zukhruf/rpc`

**The transport and the map of the requests that wait for an answer.** This code is no longer in this package (#4984). `Connection`, `Connector`, `ConnectionSupervisor`, `ConnectionClosedError`, the envelope and the four channel adapters (`WorkerConnection`, `ParentPortConnection`, `ChildProcessConnection`, `ProcessChannelConnection`) moved to `@zukhruf/rpc`, which carries this package's messages in the envelope of the tag `'@lock'` (`lockChannel` in `remote/protocol.ts`), byte for byte as before. The map of the requests (#2538) was in three places: `RemoteLockClient`, `Queries` and the single flight's `FlightClient`. It is `PendingCalls` of `@zukhruf/rpc` now: `RemoteLockClient` keeps its acquires and tries in one table and its looks in another, each call holding the link while it waits (`ConnectionSupervisor.hold()`, rpc ADR 0004); an acquire and a look go again after a loss, and a try is answered busy when the next connection opens (rpc ADR 0001). The rows of the two kinds of adapter moved to [the note of `@zukhruf/rpc`](../../rpc/docs/copied-code.md). The single flight's copy of `remote/` is gone too ([its note](../../single-flight/docs/copied-from-mutex.md)).

## Moved to `@zukhruf/fs`

**A presence that outlasts its record.** This code is no longer a copy. The knowledge moved to `Presence` of `@zukhruf/fs` ([its ADR 0007](../../fs/docs/adr/0007-a-presence-is-a-file-lock-that-its-owner-holds-while-it-lives.md), #5463): an owner holds a file lock on a file of its own from before its record appears until after the record is gone, and a deleter deletes another owner's file only while it holds the lock, in the order of each system. It was in four places: `Presence` of this package (now `CallerPresence`), `SessionDirectory` with `SessionRecord`, `ListenerPresence` of `@zukhruf/sqlite-notify`, and the install lease of `@zukhruf/git-hooks`. Each place keeps its own records, names of files and rule for a missing file:

- `CallerPresence` (`file-system/caller-presence.ts`) keeps `pathOf`, `judge`, `isNamedCallerPresent`, and the rule that a missing presence file is a fault while the record names the caller. The delete of a gone caller's file now holds its lock.
- `SessionDirectory` (`socket/session-directory.ts`) keeps `sessions/<id>.json` and `sessions/<id>.presence`, its listing, and the rule that a missing presence file is a session that stopped. Its open of a new presence tries again for at most 1 second while a recovery holds the file. `#deleteIfFree` and `unlinkRefused` are gone.
