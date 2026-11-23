# SocketStore

A host lock store with a coordinator. The processes that use it elect one leader, and the leader grants keys to all of them through a Unix socket.

| Reach | Order                                  | Holder process stops           | Default token source       |
| ----- | -------------------------------------- | ------------------------------ | -------------------------- |
| Host  | First come, first served (in one term) | Released in approximately 2 ms | `EpochTokenSource` (fixed) |

## What

All processes that use `SocketStore` with the same directory are candidates. The first process that needs a key when no leader exists wins the election ([ADR 0001](../adr/0001-every-process-is-a-candidate.md)). It becomes the coordinator and listens on the socket of the directory: `<directory>/lock.sock` on macOS and Linux, or a named pipe on Windows. All processes, the leader also, ask the leader for keys through that socket.

```ts
import { Mutex } from '@zukhruf/mutex';
import { SocketStore } from '@zukhruf/mutex/socket';

await using store = new SocketStore('/var/lib/my-app/locks', {
  clock: globalThis,
});
const mutex = new Mutex(store);
store.on('role', (role) => console.log(`This process is the ${role}`));
```

## Why

The other host lock stores poll. A waiter learns about a release, or about a stopped holder, only at its next attempt. With a coordinator, the leader tells the next waiter at once. The kernel closes the connection of a process that stops, so the leader also knows at once.

The leader is a normal app process. You do not start or watch a separate server.

## When

- More than one process on one host writes to the resource.
- You want the next waiter to get the key soon after a release.
- You want fast recovery when a holder stops.

## When not

- One process does all the writes. Use [MemoryStore](./memory-store.md).
- On macOS and Linux, the directory path is long. The absolute socket path `<directory>/lock.sock` must be 103 bytes or less on macOS, and 107 bytes or less on Linux. (Windows has no such limit.) [`@zukhruf/pipes`](../../../pipes/README.md) checks it when the store is made.
- Your processes start and stop very often while other processes hold keys. Each stop of the leader causes a failover, and the new leader grants nothing until its recovery ends when the old leader did not shut down cleanly.
- Your processes often freeze or block their event loop for a long time. A process that is frozen during a failover delays each grant of the directory up to its `leaseDuration`, also when it holds no key.

## How it works

1. A process needs a key and connects to the socket of the directory. On Windows, the socket is the named pipe `\\.\pipe\zukhruf-mutex-<hash of the socket path>` ([`@zukhruf/pipes` ADR 0005](../../../pipes/docs/adr/0005-a-rooted-name-on-windows-is-a-pipe-named-by-a-hash-of-its-path.md)). Versions up to 0.8.18 used `\\.\pipe\mutex-<hash of the directory>`, so they do not meet later versions on Windows. Windows removes a named pipe when its process stops, so a new leader has no stale socket file to remove.
2. Before its first connection, the store records its **session**: it takes its presence, a kernel lock on `<directory>/sessions/<id>.presence`, and then writes `<directory>/sessions/<id>.json` with its `leaseDuration`. The id is random for each store object. When the store is disposed, it deletes the record and then frees the presence. The next leader learns from these records which sessions can hold keys ([ADR 0033](../adr/0033-a-new-leader-grants-nothing-until-each-recorded-session-reasserted-its-keys-stopped-or-missed-its-lease.md)).
3. If no process listens, the process starts a campaign. The election is `SqliteElection` of [`@zukhruf/election`](../../../election/docs/concepts/leader-election.md), with the claim file `<directory>/leader.lock` and the epoch file `<directory>/leader.epoch`. If the process wins, it starts the server and connects to itself.
4. The leader grants keys in the order of the requests. Each fencing token contains the epoch of the leader, so a new leader's tokens are higher than all tokens of earlier leaders.
5. The leader does not stay alive only to serve others. When its own work ends, it stops, and a failover occurs.

**Failover.** When the leader stops, or when it loses its term, the kernel or the leader closes all connections to it. Then this occurs:

1. Each follower sees its connection close.
2. Each follower connects again or tries the claim. One candidate wins and becomes the new leader with a higher epoch. A candidate that lost its try waits until the old leader leaves or a step of a back-off ends (25 ms, × 1.6, ± 20 %, at most 1000 ms), and then it connects again.
3. Before it listens, the new leader lists the session records. It deletes the records of the sessions whose presence is free: they stopped. The other sessions, its own session too, are the recovering sessions. Then it listens and starts its **recovery**. During the recovery, it grants no keys.
4. Each session **reasserts** its keys: it tells the new leader the keys and tokens that it holds. Then it sends the end-of-reasserts marker. A session that holds no key sends only the marker.
5. Each waiter sends its request again.
6. The recovery of one session ends at its marker, when its presence is free, or when its `leaseDuration` ends, counted from the listen of the new leader. When the recovery of each recovering session ended, the new leader grants keys to the waiters.

The recovery prevents a waiter from getting a key that a holder still has. No timer ends it while a session runs and reconnects within its `leaseDuration`, so a holder that reconnects slowly keeps its key. For two reasserts of one key, the higher token wins. A reassert after the recovery, or after the `leaseDuration` of its session ended, is refused. Then the signal of that holder's lease aborts with `LeaseLostError`, and the call of that holder rejects with `LeaseLostError`. Its token is lower than each token of the new leader, so a fenced resource refuses its late writes. See [ADR 0033](../adr/0033-a-new-leader-grants-nothing-until-each-recorded-session-reasserted-its-keys-stopped-or-missed-its-lease.md).

The first leader of a directory (epoch 1) has no recovery, because no earlier leader had holders.

**A frozen leader.** A leader that is frozen, for example during `SIGSTOP`, keeps its connections open and answers nothing. Each follower observes the leader through the heartbeat of `SqliteElection`. When the leader sends no heartbeat for longer than its `leaseDuration`, a follower ends the leader's process, and a failover occurs. A process that waits for a leader that froze before its server listened ends it in the same way. See [ADR 0031](../adr/0031-a-follower-observes-the-leader-so-a-frozen-leader-is-ended.md).

**Clean shutdown.** A new leader also has no recovery after a clean shutdown of the leader before it, also while other sessions have records. A leader shuts down cleanly when it disposes its store, no process holds a key, and its own recovery is over or it had none. Its lock server then resigns the term with `clean`, and the next term reads `afterCleanShutdown` ([`@zukhruf/election`](../../../election/README.md)). A waiter is not a holder: it sends its request again to the new leader. Thus a process that runs alone after another process disposed its store gets its first key at once. See [ADR 0018](../adr/0018-the-next-leader-skips-the-grace-window-after-a-clean-shutdown.md).

**A lost term.** The leader stops its server when the signal of its term aborts, because another process can lead then. `SqliteElection` never takes the term from a living leader, so this occurs only with a backend that can take the claim away.

**An epoch with no tokens left.** One term gives at most 2^32 − 1 fencing tokens (`EpochTokenSource` of `@zukhruf/fencing`). When the leader needs one more token, it stops its server and ends its term, as on a shutdown. Its followers then elect a new leader, which can be the same process, with a higher epoch. They send their requests again, and they reassert their keys during the recovery. At 1,000 grants each second, a term gives its last token after approximately 50 days. See [ADR 0019](../adr/0019-a-failed-token-mint-answers-the-request-and-an-exhausted-epoch-ends-the-term.md).

**Rules for the directory.**

- Do not delete `leader.lock` while processes use the directory. A new file has no lock on it, so a second process wins, and two leaders grant the same keys.
- Do not use `leader.lock` or `leader.epoch` in the directory for another election. That election and the lock store would be one election.
- The leader closes its socket first and ends its term second. In the other order, the old leader can delete the socket file of the new leader.
- Do not delete a file in `sessions` while processes use the directory. A new leader would not wait for that session, and it could grant a key that the session still holds.

**Shutdown.** `await store[Symbol.asyncDispose]()` (or `await using`) closes the connection of this process. Each waiter in this process gets an error. If a campaign of this process is in progress, the campaign stops, and the process does not start the server. If this process is the leader, it first waits until its own server read its last requests, such as the release of its last key. Then it closes all connections, stops the server, and ends its term. Followers then elect a new leader and keep their keys. When no process held a key, the term ends with a clean shutdown, and the new leader has no recovery. Then the store deletes its session record and frees its presence.

Messages are lines of JSON. A socket does not keep message boundaries: in a test, two small messages arrived in one piece, and one large message arrived in 25 pieces of 8,192 bytes.

## Acquire modes

`tryAcquire` sends one `try` request, and the coordinator answers `granted` or `busy` at once. A caller that gives up while it waits sends `cancel`. If the grant was already on its way, the caller gives the key back. During the recovery after a failover, every `try` is answered `busy`. See [acquire modes](../concepts/acquire-modes.md).

## Holder check

`isHeld(key)` sends an `isHeld` request, and the leader answers from its memory. A process that has no leader campaigns first, as it does for an acquire. Thus a holder check can make the process the leader and write the term. A new leader answers only after its recovery, because the holders from before the failover reassert their keys in it.

See [ADR 0015](../adr/0015-a-holder-check-never-acquires-the-key.md).

## Failure modes

| Event                                                         | Result                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A holder stops                                                | The leader releases its keys in approximately 2 ms. Its session record stays until the next recovery deletes it.                                                                                                                                                                                   |
| The leader stops                                              | A failover occurs. Holders reassert their keys during the recovery. After a clean shutdown, there is no recovery, because no process held a key.                                                                                                                                                   |
| The leader freezes                                            | After its `leaseDuration`, a follower ends the leader's process, and a failover occurs. Holders reassert their keys during the recovery. A follower cannot end a leader of another user.                                                                                                           |
| The leader loses its term                                     | The leader closes its server, and a failover occurs. This needs a backend that can take the claim away; `SqliteElection` never does.                                                                                                                                                               |
| A holder reconnects slowly after a failover                   | It keeps its key while it reconnects within its `leaseDuration`, counted from the listen of the new leader. The new leader grants nothing until it reasserted its keys and sent its marker.                                                                                                        |
| A holder is frozen past its `leaseDuration` during a failover | Its recovery ends at its `leaseDuration`, and the new leader refuses its reasserts. A newer holder can get the key. When the frozen holder continues, the signal of its lease aborts with `LeaseLostError`, and the call rejects with `LeaseLostError`. A fenced resource refuses its late writes. |
| A process that holds no key is frozen during a failover       | The new leader grants nothing until the `leaseDuration` of that process ends, or until it continues and sends its marker.                                                                                                                                                                          |
| A process with a session record stops during a failover       | The new leader finds its presence free, deletes its record, and does not wait for it.                                                                                                                                                                                                              |
| The epoch of the leader has no tokens left                    | The leader closes its server and ends its term, and a failover occurs. The request that needed the token goes to the new leader.                                                                                                                                                                   |
| A holder thread stops                                         | Its connection closes, and the key is released.                                                                                                                                                                                                                                                    |
| A campaign fails, for example with a disk error               | Each waiter gets that error. For a holder that did not reassert its keys, the signal of the lease aborts with `LeaseLostError`. The next `acquire` connects again.                                                                                                                                 |

See [failure modes](../concepts/failure-modes.md).

## Protocol version

Before a process sends its first request, it tells the leader its protocol version and the id of its session: `{"op":"hello","version":3,"session":"<id>"}`. This package version speaks protocol version 3. Package versions from 0.3.45 until the release that builds [ADR 0033](../adr/0033-a-new-leader-grants-nothing-until-each-recorded-session-reasserted-its-keys-stopped-or-missed-its-lease.md) speak protocol version 2, and package versions 0.3.1 to 0.3.44 speak protocol version 1. If the leader speaks another protocol version, it refuses the process, and the acquire fails at once with `ProtocolVersionError`. The leader also refuses a process whose first line is not a `hello` of its protocol version, for example a `hello` with no session id. Thus a leader never reads a request that it can read incorrectly. Use one package version in all processes that share a directory. See [ADR 0014](../adr/0014-a-process-says-its-protocol-version-before-its-first-request.md).

`ProtocolVersionError` has two properties: `ours` is the protocol version of this process, and `theirs` is the protocol version of the leader.

## Options

| Option                       | Default | Description                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `directory` (first argument) | —       | The shared directory. All processes must use the same path. It belongs to the lock store alone: no other program may add, change, or remove files or folders in it.                                                                                                                                                                                                                      |
| `leaseDuration`              | `15000` | The longest silence of this process that the other processes accept. A follower ends this process when it leads and sends no heartbeat for longer. A new leader ends the recovery of this session when it sends no marker for longer after the listen, and then refuses its reasserts. Set it above the longest pause of your processes. The default is the default of `SqliteElection`. |
| `clock`                      | —       | The clock of the waits of the store: the back-off between two tries, the heartbeats of the leader and their deadline, and the deadlines and checks of the recovery. Give `globalThis` in production; a test gives a fake clock, for example `createClock()` of `@sinonjs/fake-timers` ([`@zukhruf/async`](../../../async/README.md#run-a-wait-on-a-clock)).                              |

`SocketStore` always uses `EpochTokenSource`. The safety of a failover depends on the epoch, so you cannot change the token source.

The `'role'` event tells you each time this process starts to lead, or starts to follow a leader. A follower gets the event again after each failover. To keep the current role, store the last value that the event gave you.

## Evidence

- **A naive takeover is not safe.** Two servers that each did "connect, see `ECONNREFUSED`, delete the socket file, listen" both listened in 11 of 20 races. Clients were split between them. Thus the lock store elects its leader before it removes the socket file.
- **`ECONNREFUSED` does not mean "no leader".** On macOS, a live leader with a full connection queue also gave `ECONNREFUSED`, after 128 queued connections (`kern.ipc.somaxconn`). Linux gives `EAGAIN` there (probe 2026-11-23, #5424).
- `src/lock-stores/socket/lock-server.test.ts`: a server whose term is lost closes without a call to `close`, and a follower then leads with a higher epoch. A server that starts for a lost term rejects with `LeaseLostError` and serves nobody.
- `src/lock-stores/remote/remote-locking.test.ts` (`A request whose epoch has no tokens left`): the coordinator reports the exhausted epoch once, answers nothing, and keeps the connection. No test reaches the end of a real epoch, which needs 2^32 grants, so no test runs the step-down of `LockServer` for it.
- After `SIGKILL` of a client, the server saw the connection close in 1.25 ms.
- **A grace window of a fixed time refuses live holders** (#5265). The window was a timer that started before the new leader listened. In a Linux replica with half a CPU and four busy loops, 2 of 8 runs of two failover tests failed. In one, the holder did not keep its key. In the other, the new leader refused the reassert of its own process 303 ms after its window of 200 ms started, and the waiter entered while the holder ran (journal `['holder:enter', 'waiter:enter']`). With a delay of 450 ms before the successor serves, 3 of 6 runs failed on macOS. A blocked event loop runs an expired timer before it reads a socket that has data (10 of 10 runs on macOS and on Linux), so a larger window does not remove the race. Thus the recovery waits for facts, not for a time ([ADR 0033](../adr/0033-a-new-leader-grants-nothing-until-each-recorded-session-reasserted-its-keys-stopped-or-missed-its-lease.md)).
- The tests of the recovery, the session records and protocol version 3 are listed in ADR 0033.
- `src/lock-stores/socket/socket-store.test.ts`:
  - A holder keeps its key when the leader stops, and a waiter gets the key only after the release.
  - A holder that is frozen past its `leaseDuration` sees the signal of its lease abort before it writes. A fenced resource refuses its write (`'stale'`), and the call rejects with `LeaseLostError`.
  - A leader that shuts down does not wait for its followers, and a follower keeps its key.
  - A leader that shuts down while a follower holds a key leaves a recovery to the next leader. The holder reasserts its key, and a waiter gets the key only after the release. When the lock server resigns clean on each close, this test fails 3 of 3 runs.
  - A process that runs alone after a process that disposed its store with no key held gets its key at once, on a clock that never moves, so no wait of the recovery can end. Before the clean shutdown, with the grace window of 500 ms, it took about 515 ms.
  - A leader frozen with `SIGSTOP` for longer than its `leaseDuration` of 500 ms is ended by a follower. A survivor leads, the holder keeps its key, and the survivor grants the key after the release.
  - A process ends a leader that froze before its server listened, and then it leads.
- `src/lock-stores/socket/electing-connector.test.ts`: a process whose leader serves no lock server makes one try, and tries again only when the leader leaves. Under a holder that serves no pipe, it tries again after one step of the back-off, not before.
- A mutation test removed the grace window, the reassert, and the epoch. The tests found each change. The build of ADR 0033 does the same for each rule of the recovery.
- `src/lock-stores/socket/handshake.test.ts`:
  - A process whose leader speaks another protocol version fails its acquire, and the error gives both protocol versions.
  - A holder whose `hello` gets to a leader that stops keeps its key from a new leader that already leads.
  - A leader refuses a process that opens with a `hello` of another protocol version, a `hello` with no protocol version, a line that is not JSON, or a request, and its followers keep working.
