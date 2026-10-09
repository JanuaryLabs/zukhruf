# Failure modes

A lock store must also work when something stops. This page tells you what each lock store does when a holder or a coordinator stops or freezes.

## Three kinds of failure

- **A holder stops.** Its process or thread ends before it releases the key, for example after a crash or `SIGKILL`.
- **A holder freezes.** Its process stays alive but does not run, for example during `SIGSTOP` or a long pause. To other processes, a frozen holder looks the same as a slow holder.
- **A coordinator stops.** This applies only to the lock stores that use a coordinator: `ThreadStore`, `IpcStore`, and `SocketStore`. For `ThreadStore`, the coordinator's thread stops only together with the workers that it started, so no holder or waiter is left.

## What each lock store does

| Lock store             | A holder process stops                                                                    | A holder thread stops                        | A holder freezes                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `MemoryStore`          | The lock stops with the process.                                                          | — (one instance cannot be shared by threads) | Waiters wait.                                                                                     |
| `ThreadStore`          | The lock stops with the process.                                                          | Released when the worker emits `exit`.       | Waiters wait.                                                                                     |
| `IpcStore`             | Released in approximately 2 ms. The parent sees the connection close.                     | —                                            | Waiters wait.                                                                                     |
| `TicketQueueFileStore` | Released. The kernel ends the presence of the holder, and a waiter removes its ticket.    | Released.                                    | Waiters wait.                                                                                     |
| `LockFileStore`        | Released. The kernel ends the presence of the holder, and a waiter removes its lock file. | Released.                                    | Waiters wait.                                                                                     |
| `SqliteStore`          | Released. The kernel removes the file lock.                                               | Released.                                    | Waiters wait.                                                                                     |
| `SocketStore`          | Released in approximately 2 ms. The leader sees the connection close.                     | Released.                                    | Waiters wait. After a failover, the holder gets a lost lease, and the signal of its lease aborts. |

The file lock stores identify a holder by its [presence](../adr/0012-a-file-store-holder-is-judged-by-its-presence.md), not by its process ID. The kernel ends the presence when the process or the thread stops. This is also true for a zombie process, and for containers that share one lock directory on one machine.

**No lock store can release the key of a frozen holder safely.** A frozen holder can continue at any time. Only a [fenced resource](./fencing-tokens.md) can refuse its late writes.

## When a coordinator stops or a campaign fails

| Lock store                       | Waiters                                                                                                                        | Holders                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `IpcStore` (the parent stops)    | Get `CoordinatorUnavailableError`. On Windows, Node.js stops the children too, unless they were started with `detached: true`. | Keep the key. No coordinator is left to grant it to another holder ([ADR 0004](../adr/0004-parent-stops-held-keys-stay.md)). |
| `SocketStore` (the leader stops) | Send their request to the new leader.                                                                                          | Reassert during the grace window. A refused reassert gives a lost lease.                                                     |
| `SocketStore` (a campaign fails) | Get the error of the campaign, for example a disk error. The next request connects again.                                      | The signal of their lease aborts with `LeaseLostError`. No leader got their reassert, so another holder may have the key.    |

## Errors

- **`LeaseLostError`** of `@zukhruf/lease`: another holder may have your key now. Its `subject` is the key. While the task runs, the signal of the lease aborts with this error. When the task ends, the call rejects with this error, also when the task returned a value. If the task threw a different error, that error is the `cause`. See [ADR 0013](../adr/0013-a-lost-lease-aborts-the-signal-of-the-lease.md).
- **`CoordinatorUnavailableError`**: no coordinator is left that can grant the key. The request did not run.
- **`ProtocolVersionError`**: the leader of a `SocketStore` speaks another protocol version, so this process cannot use it. The request did not run. Run one protocol version in each directory. See [SocketStore](../stores/socket-store.md#two-package-versions-in-one-directory).

If the task throws an error and the release also throws, you get a `SuppressedError` that contains both errors. A lost key is not a release error: the release of a lost key does not throw.

The signal tells the task about a loss that the lock store saw. A holder that continues after a freeze can write before its lock store sees the loss. Thus the signal is a warning, and the fencing token is the protection.

## Known limits

- **Holders on other machines.** A presence is a kernel lock, so it works only between callers on one machine. On Linux and Windows, the lock stores refuse a directory on a network file system. On macOS they cannot find the type of the file system, so do not share a lock directory between machines.
- **A lock record of an older version.** An older version of the file lock stores kept no presence. If a waiter finds a lock record without a presence file, the acquire fails with an error that gives the names of both files. Stop the processes that use the older version. Then delete the record.
- **A reclaim file of an older version.** An older version wrote `<key>.lock.reclaim` as JSON. The acquire fails with an error that gives the name of the file. Stop the processes that use the older version. Then delete the file.
- **An empty presence file.** A caller that stops between two steps of a release can leave a `.presence` file. The file has no lock, so it blocks no key. You can delete it.
- **A presence file that Windows refuses for longer than 1 second.** If another program keeps a presence file open, the release cannot delete the file. The key is free, but the release fails with an error that gives the name of the file.
- **A lock file that Windows refuses for longer than 1 second.** On Windows, another program can hold a lock file open with no sharing, for example a virus scanner. The file lock stores try again for up to 1 second. After that, the call fails with `EPERM`, `EACCES`, or `EBUSY`, because Windows gives the same error for a real permission denial. See [ADR 0011](../adr/0011-a-windows-refusal-of-a-lock-file-is-tried-again-for-a-limited-time.md).
- **Token sources in memory.** Their tokens start again at 1 when the process starts again. See [fencing tokens](./fencing-tokens.md#token-sources).
