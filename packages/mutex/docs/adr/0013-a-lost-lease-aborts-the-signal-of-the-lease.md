# A lost lease aborts the signal of the lease

A holder learned that it lost its key only when its lease was released ([ADR 0007](./0007-the-connection-is-separate-from-the-lock-requests.md)). At that time, the task had already done its work. A task that also threw an error got a `SuppressedError`, not a `LockLostError`. Thus the lease that a task gets has a signal. The lock store aborts the signal with a `LockLostError` when another holder may get the key, and the task can stop before its next write. The task gets only the lease: the fencing token and the signal. The lock store gives the mutex a **lock handle**: the lease and the release. Only the mutex releases the key. When the task ends after its signal aborted, the call rejects with `LockLostError`. If the task returned a value, or threw the reason of the signal, the call rejects with the reason of the signal. If the task threw a different error, the call rejects with a new `LockLostError`, and the error of the task is its `cause`. Thus `instanceof LockLostError` means that the key was not exclusive. The release of a lost key does not throw. This decision replaces "Each holder gets `LockLostError` when it releases" in ADR 0007.

## Considered Options

- **`LockLostError` only at the release.** This was the behavior before. The task learns about the loss after it did all its writes.
- **A callback on the lease, for example `onLost`.** In JavaScript, an `AbortSignal` is the standard way to stop work: `fetch`, the Web Locks API, and node-redlock use it. A task can also give the signal to each call that takes a signal.
- **The release on the lease of the task.** A task could then release its key early, and another holder could get the key while the task still runs.

The names follow the terms of other lock libraries: a **handle** that releases the lock when you dispose it (.NET DistributedLock), a **signal** that aborts when the lock is lost (node-redlock), and a **lease** with a fencing token (Chubby).

## Consequences

- Only the lock stores that use a coordinator over a socket can lose a key while the holder runs: `SocketStore`, after a failover. `ThreadStore` and `IpcStore` keep held keys when their coordinator stops ([ADR 0004](./0004-parent-stops-held-keys-stay.md)). The other lock stores never lose a key while the holder runs, and `leaseFor` gives them a signal that never aborts.
- A lock store that you write returns a `LockHandle`, not a `Lease`. See [Write your own lock store](../recipes/write-your-own-lock-store.md).
- A frozen holder can write before its lock store sees the loss. The signal is a warning, and the fencing token is still the protection.
