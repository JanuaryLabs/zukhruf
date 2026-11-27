# Code copied from the mutex

A single flight elects a coordinator among the processes that use one directory. Each caller then talks to that coordinator over a socket. The mutex's socket lock store already does both. This package keeps its own copy of that code, and does not share it with the mutex yet.

The reason is the Rule of Three. It counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. The boundary of a shared package then comes from three working copies, not from a guess. The mutex's wire also stays as it is, so old and new mutex processes cannot split into two leaders. When a third consumer needs this code, the shared parts move to `@zukhruf/coordinator` (backlog #2496). Until then, a fix in one copy is made in the other copy too, and the commit names both files. This note is the input for that step.

This note keeps three kinds of records. The first sections list the files that this package copied, and what differs in each. [Knowledge shared with the mutex](#knowledge-shared-with-the-mutex) lists the rules that the two packages each write in their own code. [In two places inside the single flight](#in-two-places-inside-the-single-flight) lists the code that this package repeats in itself, as the [mutex note](../../mutex/docs/copied-code.md) does for the mutex.

Paths on the left are in `packages/mutex/src`. Paths on the right are in `packages/single-flight/src`.

On 2026-10-10, the mutex changed several of these originals. The maintainer chose to change the mutex first, and this package later. Backlog #2541 lists each change and the mutex commit that this package copied. The same day, this package copied each change (commits `dab7a50` to `a402b02`). Thus the copies match the mutex again, except for the differences below.

On 2026-11-09, this package copied the mutex commits `39f1cb3` and `d9a7c36` (backlog #3111). The maintainer's rule is: do not design for older versions. Thus a coordinator refuses each first line that is not a hello of its protocol and version. A hang-up has no deadline. `ProtocolVersionError` always has `theirs`. The `unsupported` answer and `RequestEnvelope` are gone.

On 2026-11-16, this package copied the mutex commit `cc26618` (backlog #4371, step 3c). A follower observes the coordinator with the `LeaderObserver` of `@zukhruf/election`, so a frozen coordinator is ended ([ADR 0011](./adr/0011-a-follower-observes-the-coordinator-so-a-frozen-coordinator-is-ended.md)). The 10 ms waits of the electing connector are gone. `SingleFlightOptions` has `leaseDuration`, as `SocketStoreOptions` has.

## Moved to `@zukhruf/rpc`

The transport is no longer a copy (#4984). `connection/connection.ts`, `connection/connector.ts`, `connection/connection-supervisor.ts` and `connection/connection-closed-error.ts` are deleted: `Connection`, `Connector`, `ConnectionSupervisor` and `ConnectionClosedError` come from `@zukhruf/rpc`, as in the mutex. `Connection.close()` returns a promise here too, so the supervisor waits for it as the mutex's did. `FlightConnection` and `FlightConnector` are in `protocol/flight-protocol.ts`. The map of the runs that wait for an answer is `PendingCalls` of `@zukhruf/rpc`: `FlightClient` keeps only the `onJoin` of each run and its wait for the key's lock beside it. Each run goes again after a loss. The supervisor's `Unavailable` state still cannot occur in this package: `ElectingConnector.connect` never gives `undefined` (backlog #2520).

## Moved to `@zukhruf/fs`

The file helpers and the check that refuses a network directory are no longer copies. Both packages use `@zukhruf/fs` (its ADR 0001): `durableWrite`, `isErrno`, `patiently`, `assertLocalDirectory`, and one `NetworkDirectoryError` class that this package gives from its entry point.

## Moved to `@zukhruf/election`

The election is no longer a copy. `@zukhruf/election` holds it, made into one campaign with a subclass for each backend ([its ledger](../../election/docs/copied-code.md)). The mutex uses it since 2026-10-10, and this package too, since the same day (backlog #2530). The copy `election/` of this package and its SQLite helper `shared/sqlite/is-busy.ts` are deleted. The claim on `flight.lock` is now a `FileLock` of `@zukhruf/fs`. Its journal is in memory, so a coordinator that stops leaves no `flight.lock-journal` file. A published version claims `flight.lock` with an exclusive SQLite transaction, and that transaction and the file lock exclude each other (`flight-protocol.test.ts` pins both directions).

## Copied without a change

| Mutex                                         | Single flight                         |
| --------------------------------------------- | ------------------------------------- |
| `shared/is-record.ts`                         | `shared/is-record.ts`                 |
| `lock-stores/socket/leave-errors-to-close.ts` | `connection/leave-errors-to-close.ts` |
| `lock-stores/socket/json-line.ts`             | `connection/json-line.ts`             |

## Copied with changes

**`lock-stores/socket/socket-election.ts` → `connection/flight-election.ts`.**
The claim file is `flight.lock`, not `leader.lock`. The epoch file is `flight.epoch`, not `leader.epoch`. The function is `flightElection`, not `socketElection`. Both take `leaseDuration` as the third argument and give it to `SqliteElection`.
Why: a single flight and a socket lock store can use one directory. With the same file names, they would share one election. The winner would serve only one of them, and the other one would never find a server.

**`lock-stores/socket/socket-connection.ts` → `connection/socket-connection.ts`.**

- In the mutex, an `end()` method half-closes the socket and waits until the peer closes its side too.

Why: the mutex's `OwnServerConnection` (`lock-stores/socket/own-server-connection.ts`) closes with `end()` ([mutex ADR 0018](../../mutex/docs/adr/0018-the-next-leader-skips-the-grace-window-after-a-clean-shutdown.md)). The single flight has no such connection.

**`lock-stores/socket/local-directory-connector.ts` → `connection/local-directory-connector.ts`.**
Only its types and comments change.

**`lock-stores/socket/handshake.ts` → `connection/handshake.ts`.**

- The hello names the protocol: `{"op":"hello","protocol":"single-flight","version":1}`. The refusal names it too.
- `FIRST_LINE_LIMIT` stays 1024 bytes.
- `PROTOCOL_VERSION` stays 1. The mutex is at 2 (`dc933c5`), because its welcome stopped listing requests. This welcome never listed requests. A process of version 1 sends only requests that a coordinator of version 1 knows, so no `unsupported` answer crossed the wire between such processes, and removing that answer changes no message that they exchange.
- The mutex is at 3 since [mutex ADR 0033](../../mutex/docs/adr/0033-a-new-leader-grants-nothing-until-each-recorded-session-reasserted-its-keys-stopped-or-missed-its-lease.md): its hello carries the id of the session of the store, `{"op":"hello","version":3,"session":"<id>"}`. The mutex's `greet` takes the session id, and its `welcome` gives the id of a hello that it welcomes, or `undefined`; it refuses a hello with no session. This hello has no session, and this `welcome` gives a `boolean`: a coordinator of the single flight waits for no session after a failover ([ADR 0010](./adr/0010-a-leader-holds-a-kernel-lock-on-its-key-until-its-outcome-is-handed-over.md)).

Why: a hello that names its protocol cannot be read as a hello of another protocol.

**`lock-stores/socket/protocol-version-error.ts` → `connection/protocol-version-error.ts`.**
The message names the single flight's coordinator, not the socket store's leader.

**`lock-stores/socket/electing-connector.ts` → `connection/electing-connector.ts`.**

- It has no `connected` callback. In the mutex, that callback only emits the `follower` role event. This package has no role event. Thus `#follow` needs no stack that destroys the socket when the callback throws.
- `#lead` is `#coordinate`, and `#observeLeader` is `#observeCoordinator`. The comments say coordinator, not leader.
- The constant `backoff` and the classes `BetweenTries`, `Unwatched` and `Watching` are the same, except the words of their comments. In the mutex, `backoff` is in its own module, `lock-stores/socket/backoff.ts`, because the lock server checks the presence of each recovering session at its steps too (mutex ADR 0033).
- The mutex's options have `session`, the id that each hello says (mutex ADR 0033). This package says no session.
- In the mutex, `#lead` wraps its own socket in `OwnServerConnection`, so its close waits until the own lock server read the last release ([mutex ADR 0018](../../mutex/docs/adr/0018-the-next-leader-skips-the-grace-window-after-a-clean-shutdown.md)). `#coordinate` uses a plain `SocketConnection`.

**`lock-stores/socket/socket-store.ts` (`socketPathFor`, `SOCKET_PATH_LIMIT`) → `connection/socket-path.ts`.**
Both copies are gone. `@zukhruf/sqlite-notify` needed the same code, a third place, so it moved to `@zukhruf/pipes` (`88c36cd`). The mutex uses it since `4be9834`, and this package since the commit that removed `connection/socket-path.ts`. `single-flight.ts` makes `new PipeEndpoint(resolve(directory, 'flight.sock'), { prefix: 'zukhruf-single-flight' })`. The Windows pipe is `\\.\pipe\zukhruf-single-flight-<hash of the socket path>`. The limit is 103 bytes on macOS and 107 bytes on Linux.
Note: on 2026-10-09, on macOS 27 with Node.js 26.10.0, a probe listened and connected on socket paths of 104 to 111 bytes. That is not true on Node.js 26.13.0 or 24.22.2: the same probe on the same computer takes 104 bytes and refuses 105 bytes with `EINVAL` (pool map research 20h, section 2). The limit of 103 bytes keeps one byte less, for the ending zero byte of `sun_path`, as `@zukhruf/pipes` does.

**`lock-stores/socket/lock-server.ts` → `coordinator/flight-server.ts`.**

- It serves a `FlightCoordinator`, not a `LockCoordinator`. `EpochTokenSource` comes from `@zukhruf/fencing`.
- `close` ends each connection with `destroySoon`, not `destroy`.
- It gets the key locks, and gives them to the coordinator. `close` first stops the watches of the coordinator on the key locks of parked runs.
- The coordinator gets `onTokensExhausted: () => void started.close()`, as in the mutex (`fc8cf7f`, mirrored for backlog #2822). When the epoch of the term has no tokens left, the coordinator steps down, and the next term mints with epoch + 1.
- The mutex's lock server recovers after a failover (mutex ADR 0033): before it listens, it lists the session records of `<directory>/sessions` (`lock-stores/socket/session-directory.ts`) and deletes those whose presence is free. It makes its coordinator after the listen, so the deadline of each session counts from the listen, and serves each connection with the session id of its hello. It checks the presence of each recovering session at each step of the back-off and when a connection of the session closes before its marker. This server has no recovery, no session records and no checks: its key locks tell it who leads a flight ([ADR 0010](./adr/0010-a-leader-holds-a-kernel-lock-on-its-key-until-its-outcome-is-handed-over.md)).
- `close` resigns the term without options. The lock server resigns clean when its coordinator leaves nothing to recover ([mutex ADR 0018](../../mutex/docs/adr/0018-the-next-leader-skips-the-grace-window-after-a-clean-shutdown.md)). From [ADR 0009](./adr/0009-the-next-coordinator-skips-the-grace-window-after-a-clean-shutdown.md) to [ADR 0010](./adr/0010-a-leader-holds-a-kernel-lock-on-its-key-until-its-outcome-is-handed-over.md), it resigned clean when the coordinator left nothing to recover. Now no coordinator has a grace window, so there is nothing to skip.

Why: a coordinator process can also lead a flight. When it lands the flight and stops at once, `destroy` can drop a `landed` answer that is still on its way to a joiner. `destroySoon` sends what was written first, and then closes.

As in the mutex, the server closes itself when its term is lost. A second `close` then does not wait for the connections of the first `close` (`c142572`, after the mutex's `5ac2a20`). Thus the disposal of a single flight can end before an old connection sent a `landed` answer. The election of a single flight never takes a term from a coordinator that runs, so this cannot occur with `SqliteElection`.

## Tests copied

Four test files test the copies above. Each one is a copy of a mutex test file, so a fix to a test goes into both files too.

The test of an exhausted epoch in `coordinator/flight-coordinator.test.ts` is a copy of the test `A request whose epoch has no tokens left` in `lock-stores/remote/remote-locking.test.ts` (`fc8cf7f`). It sends a `run`, not an `acquire`, and makes its connection inline, because the mutex's `scriptedPeer` is in the mutex's own test folder.

**`lock-stores/socket/socket-connection.test.ts` → `connection/socket-connection.test.ts`.**
Only the import paths and the prefix of the Windows pipe differ.
The test "a line that is not JSON closes the connection, and a send after it fails with ConnectionClosedError" is a copy too (backlog #4984). Only the prefix of the temporary folder and the prefix of the Windows pipe differ.

**`lock-stores/socket/socket-supervision.test.ts` → `connection/socket-supervision.test.ts`, three tests.**
The group "A process whose supervisor connects over a socket" runs the supervisor of `@zukhruf/rpc` over each package's own `SocketConnection` (backlog #4668). Only the prefix of the temporary folder and the prefix of the Windows pipe differ. The stand-in tests of the supervisor, and the test "a replacement keeps the last ref()" that this package had, are in `@zukhruf/rpc` now, with the supervisor (backlog #2520).

**`lock-stores/socket/electing-connector.test.ts` → `connection/electing-connector.test.ts`.**
The tests use `flightElection` and `flight.sock`, and give no `connected` callback. The names say coordinator, not leader. Each `readline` interface on a peer of a stand-in server has an `error` listener, as the other tests of this package have. One test is only here: "a connect outlasts a coordinator that keeps its term and hangs up on each hello, for as long as that lasts".

**`lock-stores/socket/socket-store.test.ts` → `single-flight.failover.test.ts`, two tests.**
"A leader frozen past its lease duration is ended by a follower" and "a process ends a leader that froze before its lock server listened" have a test each in `single-flight.failover.test.ts`, in the group "when the coordinator freezes". They are not copies: they drive caller processes, and the first one checks that the joiner gets the outcome of the flight in progress, not that a holder keeps its key.

**`lock-stores/socket/lock-server.test.ts` → `coordinator/flight-server.test.ts`.**
A single flight has no role event. Thus the test reads `flight.epoch` to see that the next process coordinates, and it checks that a new lease token carries a higher epoch.
The test helper `listening` is byte-identical in the two files. It connects to a socket path, and gives `true` when something accepts the connection. It stays a copy: its knowledge is only in this repository, and no package exports a shared test module. The test helper `LosableElection` of the two files is in a third place, and [the ledger of the election](../../election/docs/copied-code.md#test-helpers-in-more-than-two-places) records it.

## Test helpers copied

The tests start real processes, so this package also copies two helpers from `packages/mutex/src/testing`. They are not part of the package: the build leaves `src/testing` out.

**`testing/stand-in-server.ts` → `testing/stand-in-server.ts`.**
Only its comment differs: it names a single flight, not a store.

**`testing/succeed-last-leader.ts` → `testing/succeed-last-leader.ts`.**
It wins and resigns a term of `flightElection`, not of `socketElection`. Its comment says coordinator and single flights. The tests that start caller processes dispose it after their processes, so the suite leaves no socket file of an election pipe in the temporary folder of the system.

The temporary directory of the tests is not a copy: the tests use `TemporaryFiles` of `@zukhruf/fs`, with the prefix `flights-`. The worker process is not a copy either: the tests use `startWorker` of `@zukhruf/testing/process`, as the mutex and the election do. The tests keep no copy of `fact-timeout.ts`: a wait in a test ends at the limit of the test, `t.signal` (backlog #4205).

These helpers do not belong in `@zukhruf/coordinator`. They stay copies. Only a test helper whose knowledge is in three or more repositories goes into `@zukhruf/testing` ([testing ADR 0016](../../testing/docs/adr/0016-a-test-helper-goes-into-an-area-when-three-repositories-have-its-knowledge-and-it-does-not-use-mock.md)). The knowledge of these helpers is only in this repository.

## Not copied

- `lock-stores/remote/protocol.ts`: it is the lock protocol, and this package has its own in `protocol/flight-protocol.ts`. `isFlightRequest` and `isFlightResponse` have the shape of the mutex's `isLockRequest` and `isLockResponse`.
- `lock-stores/file-system/file-lock-store.ts`. The mutex holds a `FileLock` for each key too, but the key locks are this package's own code (see the next paragraph). Both take `FileLock` from `@zukhruf/fs`. The single flight names each file by the SHA-256 of the key, so two keys that differ only in case never share a file on APFS or NTFS. The mutex names it with `safeFileName`, which encodes each uppercase letter for the same reason. The names differ in kind, so they are not one piece of knowledge.
- `lock-stores/remote/lock-coordinator.ts` and `remote-lock-client.ts`. `FlightCoordinator`, its sessions and `FlightClient` are this package's own code: one request leads or joins, and an outcome goes to every joiner. But they repeat rules of the mutex code. The next section lists them.

**This package's own code since ADR 0010.**
The key locks (`key-lock/`: `KeyLocks` and `KeyHold`) and the parked runs (`coordinator/parked-runs.ts`) have no original in the mutex. A leader holds a kernel lock on its key until its work settled and its flight needs nothing more, and the coordinator parks the runs and rejoins of a key that another process holds while it knows no flight of the key. The mutex has no such rule: its lock coordinator answers "busy" during its grace window.

## Knowledge shared with the mutex

The rules below are not file copies. Each package writes them in its own code, so the files differ, but each rule is the same knowledge. While both places exist, a fix to one goes into the other, and the commit names both files. The extraction of backlog #2496 waits for a third consumer, and it compares these rules too.

**The rule for a lost lease.**

- Places: `#fly` of `SingleFlight` (`single-flight.ts`), and `#run` of `Mutex` (`mutex/mutex.ts`).
- Same: the work gets only the token and the signal of the lease. When the work throws after the loss, the call rejects with a new `LeaseLostError`, and the error of the work is its `cause`. When that error is the reason of the signal, the call rejects with it as it is. When the work gives a value after the loss, the call rejects with the reason of the signal.
- Differs: the single flight lands each failure before it decides, so its joiners get the failure. It lands no value after the loss, because its joiners were told that the flight is interrupted. `#fly` gives its result as a value and never rejects, so a caller that stopped waiting leaves no rejection behind. ([ADR 0007](./adr/0007-a-work-error-after-a-lost-lease-rejects-with-leaselosterror.md) tells why.)
- Differs since [ADR 0010](./adr/0010-a-leader-holds-a-kernel-lock-on-its-key-until-its-outcome-is-handed-over.md): the meaning of the error. In the mutex, `LeaseLostError` tells the caller that it did not have the key alone. In the single flight, it tells the leader that its outcome reaches no joiner: the leader keeps the kernel lock on its key until its work ends, so no other run of the key runs beside it. The rule that picks the error is still the same, so a fix to it still goes into both places.
- A third place moves this rule to `@zukhruf/lease`. That step must first check that the two places still change for the same reason, because their meanings now differ.

**The wiring of an electing client.**

- Places: the constructor and `[Symbol.asyncDispose]` of `SingleFlight` (`single-flight.ts`), and of `SocketStore` (`lock-stores/socket/socket-store.ts`).
- Same: the client talks through a `ConnectionSupervisor`, a `LocalDirectoryConnector` and an `ElectingConnector`. `serve` starts the server through an `AsyncDisposableStack`, so a failure before the server fully started closes it. The servers of this process are in one stack. The disposal closes the client first, and then the servers.
- Differs: the flight server gets no recovery. It gets the key locks, and the client gets them too, with a read of the epoch on disk (`lastEpoch` of the election) to find a stale lead ([ADR 0010](./adr/0010-a-leader-holds-a-kernel-lock-on-its-key-until-its-outcome-is-handed-over.md)). The lock server gets a recovery in each term after the first, except after a clean shutdown (mutex ADR 0018, mutex ADR 0033). `SocketStore` is also a session: it makes a random session id, records the session through a `RecordingConnector` between the `LocalDirectoryConnector` and the `ElectingConnector`, and deletes the record after its client closed and before its servers close. Its `leaseDuration` defaults to 15000 in the store, because the record needs the number. `SocketStore` emits its role events: `leader` in `serve`, and `follower` from `connected`. The single flight has no role event. Both give their `leaseDuration` option to the election, and neither has a poll interval for the election. The single flight keeps a constant of 10 milliseconds for its key locks only (backlog #4433).

**The reassertion with a newer token.**

- Places: `reassert` of `FlightCoordinator` (`coordinator/flight-coordinator.ts`), and `Recovering.reassert` in `LockCoordinator` (`lock-stores/remote/lock-coordinator.ts`).
- Same: for two claims on one key, the newer token wins (`isNewerThan`), and the older claim is lost.
- Differs: the single flight has no grace window since [ADR 0010](./adr/0010-a-leader-holds-a-kernel-lock-on-its-key-until-its-outcome-is-handed-over.md). Its coordinator accepts a reassertion at any time, and a reassertion with the token of the flight in progress hands that flight to the new connection. The lock coordinator accepts a reassertion only during its recovery, from a recorded session whose lease duration has not passed, and refuses each one after it (mutex ADR 0033). The single flight keeps a `Flight` for each claim, and how the latest reasserted flight of each key ended, for a rejoin that comes after the end. The lock coordinator gets a lease from its `MemoryStore` for each claim, and it calls the `lose` callback of the older claim.
- The recovery of the mutex is not a copy. It is the mutex's own code: a `Latch` that opens when each recorded session sent its end-of-reasserts marker, stopped, or missed its lease duration (mutex ADR 0033). It replaced the grace window, a timer.

**How a session answers.**

- Places: `Session`, `Serving` and `Ended` in `coordinator/session.ts`, and `Peer`, `Serving` and `Ended` in `lock-stores/remote/lock-coordinator.ts`. The mutex renamed its `Session` to `Peer` when a session became a store across failovers (mutex ADR 0033).
- Same:
  - The session ignores a message that is not a request that it knows, and the connection stays open ([ADR 0008](./adr/0008-a-connection-closes-only-when-its-framing-breaks.md), mutex ADR 0017).
  - The session ignores a second request with an id that it already has (`#open` and `#register`).
  - A send that fails is ignored: the client is gone, and `close` comes next.
  - A request whose handling fails closes the connection.
  - A request whose epoch has no tokens left (`EpochExhaustedError`) gets no answer, and the connection stays open. The session calls `onTokensExhausted` of the coordinator, and the server closes for a new term. A close of the connection only would send the peer back to the same coordinator, and it would fail again in a loop (mutex `fc8cf7f`, single flight backlog #2822).
  - On `close`, the session goes to `Ended` first, so it answers nothing on a connection that is gone.
- Differs: the mutex's `Peer` knows the session id of its connection, gives it with each reassert, and ends the recovery of that session on the end-of-reasserts marker `{"op":"reasserted"}`, a request with no id that it never answers (mutex ADR 0033). The mutex's `Ended` gives back each lease that arrives after the end. The single flight's `Ended` answers nothing, and the session withdraws each of its parties. The single flight closes the connection through its phase, and only for a run or a rejoin that fails. Backlog #2544 is about the close after a failed request on the mutex's shared channels. The single flight uses only sockets, so #2544 does not apply to it.

**The failover rules of a client.**

- Places: `FlightClient` (`client/flight-client.ts`), and `RemoteLockClient` (`lock-stores/remote/remote-lock-client.ts`).
- Same:
  - `#lose` forgets the held entry first, and then tells the lease that it is lost. Thus a new connection does not reassert it.
  - `#fail`: no coordinator heard the reassertions, so each held entry is lost, and each request that waits rejects with the error.
  - `#resume` sets `ref` or `unref` first. Then it reasserts each held entry, and then it sends each request that waits for a connection.
  - Differs: the mutex's `#resume` sends the end-of-reasserts marker `{"op":"reasserted"}` after its reasserts and before the requests that wait, also when it holds no key (mutex ADR 0033). The single flight sends no marker: its coordinator waits for no session.
  - `#interrupt`: a request that went out on the lost connection goes again on the next one.
  - A message that is not an answer of the protocol answers nothing that the client waits for, so the client ignores it. Before `a12029c`, the single flight closed the connection for such a message, and the client connected again.
- Differs: the single flight sends each landing again after its reassertion. A run that joined a flight goes again as a rejoin of that flight. A try of the mutex is one attempt, so its policy in `PendingCalls` answers it busy when the next connection opens (rpc ADR 0001). The single flight has no `unavailable` listener. Its `#lose` also wakes `close`. Since [ADR 0010](./adr/0010-a-leader-holds-a-kernel-lock-on-its-key-until-its-outcome-is-handed-over.md), a run that the single flight's coordinator tells to lead first takes the key lock and reads the epoch, and `#interrupt` also stops that wait and sends the run again. `ack`, `#lose` and `close` tell the key hold that the flight needs nothing more from this process.

**A token on the wire.**

- Places: `isToken` in `protocol/flight-protocol.ts`, and in `lock-stores/remote/protocol.ts`.
- Same: a string that `FencingToken.parse` accepts.
- Differs: the single flight's `isToken` is a type guard. The mutex's `isToken` gives a `boolean`. The single flight also checks the `flight` of a run and of a `joined` answer with it.

## In two places inside the single flight

The code below is in two places inside this package. While both places exist, a fix to one place goes into the other place too, and the commit names both places. A third place is the time to extract the code.

The paths are in `packages/single-flight/src`.

**A joiner told that its flight ended.**

- Places: `land` and `interrupt` of `Flight` (`coordinator/flight.ts`), and `land` and `interrupt` of `FlightCoordinator`, which keep the answer of an ending for `rejoin` (`coordinator/flight-coordinator.ts`).
- Same: a joiner of a flight that landed gets `{ op: 'landed', outcome }`. A joiner of a flight that was interrupted gets `{ op: 'interrupted' }`.
- Differs: `Flight` tells each joiner when the flight ends, and on a landing it then tells the leader `ack`. `FlightCoordinator` keeps the answer of the latest reasserted flight of each key, and `rejoin` gives it to a rejoin that comes after that flight ended.

**The message of a closed single flight.**

- Places: `run` and `close` of `FlightClient` (`client/flight-client.ts`).
- Same: the text `'This single flight is closed.'`.
- Differs: `run` throws it for a call after `close`. `close` rejects each run that waits for its answer with it.

**The wake sets.**

- Places: `#released` of `FlightClient` (`close` and `#release` in `client/flight-client.ts`), and `park` and `wake` of `ParkedRuns` (`coordinator/parked-runs.ts`).
- Same: a set of functions that end a wait. The waker takes the set, clears it, and calls each function.
- Differs: the client has one set, and each release wakes `close`, which checks its condition again. `ParkedRuns` has one set for each key, with the party of each function, and one watch of the key lock for each set. A woken run or rejoin is decided again in the same step.

**The read of one JSON line.**

- Places: the `line` listener in the constructor of `SocketConnection` (`connection/socket-connection.ts`), and `parse` in `connection/handshake.ts`.
- Same: `JSON.parse` of one line of the socket's newline-delimited JSON. The write side is in one place already: `jsonLine` (`connection/json-line.ts`).
- Differs: a line that is not JSON. `SocketConnection` closes the connection, because the framing is broken ([ADR 0008](./adr/0008-a-connection-closes-only-when-its-framing-breaks.md)). `parse` gives `undefined`, and the handshake reads that as no `hello` or no answer.
- Both files are copies of the mutex files, and the mutex note records the same two places. Thus this code goes with the files to `@zukhruf/coordinator` (backlog #2496).

**No longer in two places.**
`FlightCoordinator` had two phases, `Coordinating` and `GraceWindow`, each with its own `rejoin` and its own registration of a flight. Since [ADR 0010](./adr/0010-a-leader-holds-a-kernel-lock-on-its-key-until-its-outcome-is-handed-over.md), the coordinator has no phases. `rejoin` is one method, and each new flight is registered in `#start`, for a run (`Party.lead`) and for a reassertion (`Party.resume`).

**Not counted.**
`Party.lead` sends the token as text, and `Flight.id` is the token as text too. The `lead` answer carries the token of the lease, and `Flight.id` is the name of the flight on the wire. They change for different reasons, so they are not one piece of knowledge (`261b8b4`).

**`firstOf` (test helper).**

- Places: `single-flight.failover.test.ts` and `single-flight.key-lock.test.ts`.
- Same: nothing differs. `firstOf` waits until a worker reported one of the types for a call, and gives the first such report.

A third place is the time to move it into `src/testing` (backlog #4087).

## What the extraction can share

- **As is:** the socket connection. The connection and the connection supervisor are in `@zukhruf/rpc` now.
- **With parameters:**
  - the election: done in `@zukhruf/election`, where the names of its two files are options. The mutex and this package use it;
  - the socket path: done in `@zukhruf/pipes`, where the file name and the pipe prefix are what `PipeEndpoint` takes. The mutex and this package use it;
  - the handshake: the protocol name and the version;
  - the electing connector: the `connected` callback, and what wraps the connection. It checks no message: the class that reads the protocol checks it;
  - the server: what serves each connection, and how `close` ends each connection;
  - the protocol error: the subject of its message.
- **To compare:** the rules in [Knowledge shared with the mutex](#knowledge-shared-with-the-mutex). The third consumer shows which of them are the same in kind.
- **Not shared:** each coordinator's rules, and each client's requests.
