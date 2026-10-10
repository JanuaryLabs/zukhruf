# SocketStore

A host lock store with a coordinator. The processes that use it elect one leader, and the leader grants keys to all of them through a Unix socket.

| Reach | Order                                  | Holder process stops           | Default token source       |
| ----- | -------------------------------------- | ------------------------------ | -------------------------- |
| Host  | First come, first served (in one term) | Released in approximately 2 ms | `EpochTokenSource` (fixed) |

## What

All processes that use `SocketStore` with the same directory are candidates. The first process that needs a key when no leader exists wins the election ([ADR 0001](../adr/0001-every-process-is-a-candidate.md)). It becomes the coordinator and listens on the socket of the directory: `<directory>/lock.sock` on macOS and Linux, or a named pipe on Windows. All processes, the leader also, ask the leader for keys through that socket.

```ts
import { Mutex, SocketStore } from '@zukhruf/mutex';

await using store = new SocketStore('/var/lib/my-app/locks');
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
- On macOS and Linux, the directory path is long. The socket path `<directory>/lock.sock` must be 103 bytes or less. (Windows has no such limit.)
- Your processes start and stop very often. Each stop of the leader causes a failover and a grace window.

## How it works

1. A process needs a key and connects to the socket of the directory. On Windows, the socket is the named pipe `\\.\pipe\mutex-<hash of the directory>`. Windows removes a named pipe when its process stops, so a new leader has no stale socket file to remove.
2. If no process listens, the process starts a campaign. The election is `SqliteElection` of [`@zukhruf/election`](../../../election/docs/concepts/leader-election.md), with the claim file `<directory>/leader.lock` and the epoch file `<directory>/leader.epoch`. If the process wins, it starts the server and connects to itself.
3. The leader grants keys in the order of the requests. Each fencing token contains the epoch of the leader, so a new leader's tokens are higher than all tokens of earlier leaders.
4. The leader does not stay alive only to serve others. When its own work ends, it stops, and a failover occurs.

**Failover.** When the leader stops, or when it loses its term, the kernel or the leader closes all connections to it. Then this occurs:

1. Each follower sees its connection close.
2. Each follower connects again or starts a campaign. One candidate wins and becomes the new leader with a higher epoch.
3. The new leader starts a **grace window**. During the grace window, it grants no keys.
4. Each holder **reasserts** its keys: it tells the new leader the keys and tokens that it holds.
5. Each waiter sends its request again.
6. After the grace window, the new leader grants keys to waiters.

The grace window prevents a waiter from getting a key that a holder still has. For two reasserts of one key, the higher token wins. A reassert after the grace window is refused. Then the signal of that holder's lease aborts with `LeaseLostError`, and the call of that holder rejects with `LeaseLostError`.

The first leader of a directory (epoch 1) has no grace window, because no earlier leader had holders.

**A lost term.** The leader stops its server when the signal of its term aborts, because another process can lead then. `SqliteElection` never takes the term from a living leader, so this occurs only with a backend that can take the claim away.

**Rules for the directory.**

- Do not delete `leader.lock` while processes use the directory. A new file has no lock on it, so a second process wins, and two leaders grant the same keys.
- Do not use `leader.lock` or `leader.epoch` in the directory for another election. That election and the lock store would be one election.
- The leader closes its socket first and ends its term second. In the other order, the old leader can delete the socket file of the new leader.

**Shutdown.** `await store[Symbol.asyncDispose]()` (or `await using`) closes the connection of this process. Each waiter in this process gets an error. If a campaign of this process is in progress, the campaign stops, and the process does not start the server. If this process is the leader, it closes all connections, stops the server, and ends its term. Followers then elect a new leader and keep their keys.

Messages are lines of JSON. A socket does not keep message boundaries: in a test, two small messages arrived in one piece, and one large message arrived in 25 pieces of 8,192 bytes.

## Acquire modes

`tryAcquire` sends one `try` request, and the coordinator answers `granted` or `busy` at once. A caller that gives up while it waits sends `cancel`. If the grant was already on its way, the caller gives the key back. During the grace window after a failover, every `try` is answered `busy`. See [acquire modes](../concepts/acquire-modes.md).

## Holder check

`isHeld(key)` sends an `isHeld` request, and the leader answers from its memory. A process that has no leader campaigns first, as it does for an acquire. Thus a holder check can make the process the leader and write the term. A new leader answers only after its grace window, because the holders from before the failover reassert their keys in that window.

A leader of version 0.3.9 or earlier does not know the `isHeld` request, and it closes the connection of a process that sends a request that it does not know. Thus a process sends `isHeld` only to a leader that lists it in its `welcome`. With an older leader, the holder check rejects with `UnsupportedRequestError`, and the connection and the held keys stay. See [ADR 0015](../adr/0015-a-holder-check-never-acquires-the-key.md) and [ADR 0016](../adr/0016-a-leader-lists-the-requests-that-it-added.md).

## Failure modes

| Event                                            | Result                                                                                                                                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A holder stops                                   | The leader releases its keys in approximately 2 ms.                                                                                                                                                                                     |
| The leader stops                                 | A failover occurs. Holders reassert their keys during the grace window.                                                                                                                                                                 |
| The leader loses its term                        | The leader closes its server, and a failover occurs. This needs a backend that can take the claim away; `SqliteElection` never does.                                                                                                    |
| A holder is frozen during the whole grace window | Its reassert is refused. A newer holder can get the key. When the frozen holder continues, the signal of its lease aborts with `LeaseLostError`, and the call rejects with `LeaseLostError`. A fenced resource refuses its late writes. |
| A holder thread stops                            | Its connection closes, and the key is released.                                                                                                                                                                                         |
| A campaign fails, for example with a disk error  | Each waiter gets that error. For a holder that did not reassert its keys, the signal of the lease aborts with `LeaseLostError`. The next `acquire` connects again.                                                                      |

See [failure modes](../concepts/failure-modes.md).

## Two package versions in one directory

During a rolling upgrade, processes of two package versions of `@zukhruf/mutex` can use one directory. They can share it when they speak the same protocol version. The protocol version changes only when the messages between the processes change. All package versions from 0.3.1 speak protocol version 1.

Before a process sends its first request, it tells the leader its protocol version. The leader serves it or refuses it. Package versions 0.3.0 and earlier do not tell their protocol version, and the leader does not answer them. See [ADR 0014](../adr/0014-a-process-says-its-protocol-version-before-its-first-request.md).

| This process     | The leader               | Result                                                                                                                      |
| ---------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 0.3.1 or later   | Same protocol version    | The processes share the directory.                                                                                          |
| 0.3.1 or later   | Another protocol version | The acquire fails at once with `ProtocolVersionError`. The error gives both protocol versions.                              |
| 0.3.1 or later   | 0.3.0 or earlier         | The acquire fails after approximately 1 second with `ProtocolVersionError`. `theirs` is `undefined`.                        |
| 0.3.0 or earlier | 0.3.1 to 0.3.6           | No error. The acquire does not end. The process connects again without a pause, and the leader must refuse each connection. |
| 0.3.0 or earlier | 0.3.7 or later           | No error. The leader does not answer, so the acquire does not end. The process stays connected and uses no CPU time.        |

`ProtocolVersionError` has two properties: `ours` is the protocol version of this process, and `theirs` is the protocol version of the leader.

To upgrade from 0.3.0 or earlier, stop all processes that use the directory. Then start the processes of the new package version.

## Options

| Option                       | Default | Description                                                                                                                                                         |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `directory` (first argument) | —       | The shared directory. All processes must use the same path. It belongs to the lock store alone: no other program may add, change, or remove files or folders in it. |
| `pollInterval`               | `10`    | Milliseconds between two attempts to connect or to campaign.                                                                                                        |
| `graceWindow`                | `500`   | Milliseconds after a failover in which the new leader grants no keys. It must be longer than the time that a holder needs to connect again.                         |

`SocketStore` always uses `EpochTokenSource`. The safety of a failover depends on the epoch, so you cannot change the token source.

The `'role'` event tells you each time this process starts to lead, or starts to follow a leader. A follower gets the event again after each failover. To keep the current role, store the last value that the event gave you.

## Evidence

- **A naive takeover is not safe.** Two servers that each did "connect, see `ECONNREFUSED`, delete the socket file, listen" both listened in 11 of 20 races. Clients were split between them. Thus the lock store elects its leader before it removes the socket file.
- **`ECONNREFUSED` does not mean "no leader".** A live leader with a full connection queue also gave `ECONNREFUSED`.
- `src/lock-stores/socket/lock-server.test.ts`: a server whose term is lost closes without a call to `close`, and a follower then leads with a higher epoch. A server that starts for a lost term rejects with `LeaseLostError` and serves nobody.
- `src/lock-stores/mixed-version.release.test.ts`: a process of the latest release and a process of this source share one directory. In both directions, each one sees the holder of the other, does not get its key, and gets the key after the release. The test downloads the latest release each run, so each change is checked against the version that runs beside it during an upgrade.
- After `SIGKILL` of a client, the server saw the connection close in 1.25 ms.
- `src/lock-stores/socket/socket-store.test.ts`:
  - A holder keeps its key when the leader stops, and a waiter gets the key only after the release.
  - A holder that is frozen past the grace window sees the signal of its lease abort before it writes. A fenced resource refuses its write (`'stale'`), and the call rejects with `LeaseLostError`.
  - A leader that shuts down does not wait for its followers, and a follower keeps its key.
- A mutation test removed the grace window, the reassert, and the epoch. The tests found each change.
- A test with real processes of the published package versions 0.3.0, 0.3.1 and 0.3.5 on macOS:
  - A process of 0.3.5 and a leader of 0.3.0: the acquire failed with `ProtocolVersionError` after 1,007 ms.
  - A process of 0.3.0 and a leader of 0.3.6: in 5 seconds, the process connected again 98,985 times, and the leader used 2,300 ms of CPU time. The acquire did not end. With the leader of 0.3.7: 1 connection, and 0 ms of CPU time in each process.
  - A process of 0.3.5 and a leader of 0.3.1: the process got its key in 3 ms.
- `src/lock-stores/socket/handshake.test.ts`:
  - A process whose leader speaks another protocol version fails its acquire, and the error gives both protocol versions.
  - A process whose leader keeps its term but closes the connection on the `hello` fails its acquire.
  - A holder whose `hello` gets to a leader that stops keeps its key from a new leader that already leads.
  - A leader gives no answer to a process that opens without a `hello`, and keeps it connected until its term ends. A process that connects again after each close keeps its first connection.
  - A leader closes its side when a process that it gave no answer closes its side.
