# Code that is in two places

This repository follows the Rule of Three, and it counts places, not packages. The first place writes the code. A second place copies it, and a note records the copy. A third place extracts the code to one home, and the copies go. Thus the boundary of the shared code comes from three working copies, not from a guess.

This note records the code that is in two places inside the mutex. While both places exist, a fix to one place goes into the other place too, and the commit names both files. A third place is the time to extract the code. The last section records the code that is in more than two places.

The paths are in `packages/mutex/src/lock-stores`. The code that the single flight copied from the mutex has [its own note](../../single-flight/docs/copied-from-mutex.md).

## In two places

**A connector that gives its one connection once.**

- Places: `ParentPortConnector` in `thread/thread-store.ts`, and `ProcessChannelConnector` in `ipc/ipc-store.ts`.
- Same: each connector keeps its one connection in an iterator. The first `connect` gives the connection. Each later `connect` gives `undefined`: the coordinator is gone, and nothing can replace it.
- Differs: the IPC connector first checks `process.connected`. When the channel to the parent closed, it gives `undefined` at once. A worker's port lasts as long as the worker, so the thread connector has no such check.

**Listeners only while the connection is referenced.**

- Places: `ref`, `unref` and `close` of `ParentPortConnection` (`thread/parent-port-connection.ts`) and of `ProcessChannelConnection` (`ipc/process-channel-connection.ts`).
- Same: `ref` removes the listeners and then adds them, so a second `ref` does not listen twice. `unref` removes them. `close` calls `unref`.
- Differs: the port listens for `message` only. The process channel also listens for `disconnect`, and it emits `close` then.

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

## In more than two places

The Rule of Three asks to extract the code below. It is not extracted yet. Until it is, a fix to one place goes into each place, and the commit names each file.

**The map of the requests that wait for an answer.** Three places.

- Places: `#take` and `#rejectAll` of `RemoteLockClient` (`remote/remote-lock-client.ts`), `#take` and `rejectAll` of `Queries` (`remote/queries.ts`), and `#take` of `FlightClient` (`packages/single-flight/src/client/flight-client.ts`).
- Same: a map of requests by id. An entry keeps only what settles the caller's promise. `#take` gets an entry, deletes it, and tells its owner that the map changed, so the owner can `ref` or `unref` its connection. A reject-all takes each entry and rejects it.

The maintainer chose to keep the three places (backlog #2538). The parts that are the same are short, and the parts that differ (the delivery states, what a new connection sends again, what keeps the process alive) stay with each owner. A fourth place, or the coordinator package of backlog #2496, is the time to extract it.

**The check for the envelope of a lock message.** Four places.

- Places: `#onMessage` of `ParentPortConnection` (`thread/parent-port-connection.ts`), `ProcessChannelConnection` (`ipc/process-channel-connection.ts`), `WorkerConnection` (`thread/worker-connection.ts`) and `ChildProcessConnection` (`ipc/child-process-connection.ts`).
- Same: `unwrap` the envelope, and emit `message` only when the envelope was there. The channel is shared with the application, so its own messages, which have no envelope, are dropped ([ADR 0017](./adr/0017-a-connection-closes-only-when-its-framing-breaks.md)).
- Differs: only the emitter that the adapter listens on.

**Remove the listeners, then emit `close`.** Three places.

- Places: `#onExit` of `WorkerConnection` (`thread/worker-connection.ts`), and `#onDisconnect` of `ChildProcessConnection` (`ipc/child-process-connection.ts`) and of `ProcessChannelConnection` (`ipc/process-channel-connection.ts`).
- Same: when the other side stops, the adapter removes its own listeners, and then emits `close`.
- Differs: `WorkerConnection` and `ChildProcessConnection` add their listeners in the constructor and remove them with `close`. `ProcessChannelConnection` adds them with `ref` and removes them with `unref`.

Backlog #2544 is about this code too: `close` of a worker or child connection does not emit `close`. A fix for it goes into each place.

**A listener that ignores errors, because `close` follows each error.** Three places.

- Places: the `error` listener of the socket and of the `readline` interface in the constructor of `SocketConnection` (`socket/socket-connection.ts`), and the `error` listener of the socket in `readLine` (`socket/handshake.ts`).
- Same: an empty listener. Without a listener, an error stops the process. The `close` that comes after it reports the lost connection.
- Differs: what `close` does. `SocketConnection` emits `close`. `readLine` gives `undefined` as its line.

**The first ticket of the queue.** Four places.

- Places: `tryLock` (two reads), `isHeldAt` and `isGone` of `TicketQueueFileStore` (`file-system/ticket-queue-file-store.ts`).
- Same: read the tickets again, and take the first one. The caller of the first ticket is the holder.
- Differs: what the caller does with it. `tryLock` evicts a gone head, and later compares the head with itself. `isHeldAt` and `isGone` give the read to `Presence` as `readNamed`.
