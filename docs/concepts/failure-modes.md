# Failure modes

A lock store must also work when something stops. This page tells you what each lock store does when a holder or a coordinator stops or freezes.

## Three kinds of failure

- **A holder stops.** Its process or thread ends before it releases the key, for example after a crash or `SIGKILL`.
- **A holder freezes.** Its process stays alive but does not run, for example during `SIGSTOP` or a long pause. To other processes, a frozen holder looks the same as a slow holder.
- **A coordinator stops.** This applies only to the lock stores that use a coordinator: `ThreadStore`, `IpcStore`, and `SocketStore`. For `ThreadStore`, the coordinator's thread stops only together with the workers that it started, so no holder or waiter is left.

## What each lock store does

| Lock store | A holder process stops | A holder thread stops | A holder freezes |
|---|---|---|---|
| `MemoryStore` | The lock stops with the process. | — (one instance cannot be shared by threads) | Waiters wait. |
| `ThreadStore` | The lock stops with the process. | Released when the worker emits `exit`. | Waiters wait. |
| `IpcStore` | Released in approximately 2 ms. The parent sees the connection close. | — | Waiters wait. |
| `TicketQueueFileStore` | Released. A waiter sees that the process does not exist and removes it. | **The key stays held** until the process stops. | Waiters wait. |
| `LockFileStore` | Released. A waiter sees that the process does not exist and removes it. | **The key stays held** until the process stops. | Waiters wait. |
| `SqliteStore` | Released. The kernel removes the file lock. | Released. | Waiters wait. |
| `SocketStore` | Released in approximately 2 ms. The leader sees the connection close. | Released. | Waiters wait. After a failover, the holder gets a lost lease. |

The file lock stores identify a holder by its process. A worker thread that stops does not stop its process, so nobody removes it. Release the key before you terminate a worker thread.

**No lock store can release the key of a frozen holder safely.** A frozen holder can continue at any time. Only a [fenced resource](./fencing-tokens.md) can refuse its late writes.

## When a coordinator stops

| Lock store | Waiters | Holders |
|---|---|---|
| `IpcStore` (the parent stops) | Get `CoordinatorUnavailableError`. | Keep the key. No coordinator is left to grant it to another holder ([ADR 0004](../adr/0004-parent-stops-held-keys-stay.md)). |
| `SocketStore` (the leader stops) | Send their request to the new leader. | Reassert during the grace window. A refused reassert gives a lost lease. |

## Errors

- **`LockLostError`**: another holder may have your key now. You get it when the lease is released. The task already ran, so check your fenced resource.
- **`CoordinatorUnavailableError`**: no coordinator is left that can grant the key. The request did not run.

If the task throws an error and the release also throws, you get a `SuppressedError` that contains both errors.

`LockLostError` tells you about a loss that the holder saw. A holder that continues after a freeze can write before it sees the loss. Thus `LockLostError` is a warning, and the fencing token is the protection.

## Known limits

- **A reused process ID.** The file lock stores check if a process ID exists. If the system gives the ID to a new process, the waiter waits until that new process stops. The waiter never gets the key too early.
- **A stop during a reclaim.** The file lock stores use `<key>.lock.reclaim` while they remove a stopped holder. If a process stops during that step, which takes microseconds, remove the file by hand.
- **Holders on other machines.** The file lock stores do not remove a holder from another host, because they cannot check its process.
- **Token sources in memory.** Their tokens start again at 1 when the process starts again. See [fencing tokens](./fencing-tokens.md#token-sources).
