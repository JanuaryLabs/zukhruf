# SocketStore

A host lock store with a coordinator. The processes that use it elect one leader, and the leader grants keys to all of them through a Unix socket.

| Reach | Order | Holder process stops | Default token source |
|---|---|---|---|
| Host | First come, first served (in one term) | Released in approximately 2 ms | `EpochTokenSource` (fixed) |

## What

All processes that use `SocketStore` with the same directory are candidates. The first process that needs a key when no leader exists wins the election ([ADR 0001](../adr/0001-every-process-is-a-candidate.md)). It becomes the coordinator and listens on `<directory>/lock.sock`. All processes, the leader also, ask the leader for keys through that socket.

```ts
import { Mutex, SocketStore } from 'mutex';

await using store = new SocketStore('/var/lib/my-app/locks');
const mutex = new Mutex(store);
store.on('role', (role) => console.log(`This process is the ${role}`));
```

## Why

The other host lock stores poll. A waiter learns about a release only at its next attempt, and it must find a stopped holder by its process ID. With a coordinator, the leader tells the next waiter at once. The kernel closes the connection of a process that stops, so the leader also knows at once.

The leader is a normal app process. You do not start or watch a separate server.

## When

- More than one process on one host writes to the resource.
- You want the next waiter to get the key soon after a release.
- You want fast recovery when a holder stops, and no check of process IDs.

## When not

- One process does all the writes. Use [MemoryStore](./memory-store.md).
- You use Windows. `SocketStore` supports only Unix sockets (macOS and Linux).
- The directory path is long. The socket path `<directory>/lock.sock` must be 103 bytes or less.
- Your processes start and stop very often. Each stop of the leader causes a failover and a grace window.

## How it works

1. A process needs a key and connects to `<directory>/lock.sock`.
2. If no process listens, the process starts a [campaign](../concepts/leader-election.md). If it wins, it starts the server and connects to itself.
3. The leader grants keys in the order of the requests. Each fencing token contains the epoch of the leader, so a new leader's tokens are higher than all tokens of earlier leaders.
4. The leader does not stay alive only to serve others. When its own work ends, it stops, and a failover occurs.

**Failover.** When the leader stops, a follower wins a new campaign. The new leader grants no keys during the grace window. In that time, each holder reasserts its keys and each waiter sends its request again. Then the new leader continues. See [leader election](../concepts/leader-election.md#failover-in-the-socket-lock-store).

**Shutdown.** `await store[Symbol.asyncDispose]()` (or `await using`) closes the connection of this process. If this process is the leader, it closes all connections, stops the server, and ends its term. Followers then elect a new leader and keep their keys.

Messages are lines of JSON. A socket does not keep message boundaries: in a test, two small messages arrived in one piece, and one large message arrived in 25 pieces of 8,192 bytes.

## Acquire modes

`tryAcquire` sends one `try` request, and the coordinator answers `granted` or `busy` at once. A caller that gives up while it waits sends `cancel`. If the grant was already on its way, the caller gives the key back. During the grace window after a failover, every `try` is answered `busy`. See [acquire modes](../concepts/acquire-modes.md).

## Failure modes

| Event | Result |
|---|---|
| A holder stops | The leader releases its keys in approximately 2 ms. |
| The leader stops | A failover occurs. Holders reassert their keys during the grace window. |
| A holder is frozen during the whole grace window | Its reassert is refused. A newer holder can get the key. A fenced resource refuses the late writes of the frozen holder, and the frozen holder gets `LockLostError`. |
| A holder thread stops | Its connection closes, and the key is released. |

See [failure modes](../concepts/failure-modes.md).

## Options

| Option | Default | Description |
|---|---|---|
| `directory` (first argument) | — | The shared directory. All processes must use the same path. |
| `pollInterval` | `10` | Milliseconds between two attempts to connect or to campaign. |
| `graceWindow` | `500` | Milliseconds after a failover in which the new leader grants no keys. It must be longer than the time that a holder needs to connect again. |

`SocketStore` always uses `EpochTokenSource`. The safety of a failover depends on the epoch, so you cannot change the token source.

`store.role` is `'leader'`, `'follower'`, or `undefined` before the first `acquire`. The `'role'` event tells you when it changes.

## Evidence

- After `SIGKILL` of a client, the server saw the connection close in 1.25 ms.
- `src/lock-stores/socket/socket-store.test.ts`:
  - A holder keeps its key when the leader stops, and a waiter gets the key only after the release.
  - A holder that is frozen past the grace window is refused by a fenced resource (`'stale'`) and gets `LockLostError`.
  - A leader that shuts down does not wait for its followers, and a follower keeps its key.
- A mutation test removed the grace window, the reassert, and the epoch. The tests found each change.
