# Reach

A mutex works only when all callers ask the same lock store. The **reach** of a lock store is the set of callers that can share its locks. Select the reach before you select the lock store.

## The four reaches

| Reach | Who shares a lock | Lock stores |
|---|---|---|
| **Instance** | The callers of one lock store object | [MemoryStore](../stores/memory-store.md) |
| **Process** | All threads of one process | [ThreadStore](../stores/thread-store.md) |
| **Process tree** | One parent process and the children it started | [IpcStore](../stores/ipc-store.md) |
| **Host** | All processes on one machine | [TicketQueueFileStore](../stores/ticket-queue-file-store.md), [LockFileStore](../stores/lock-file-store.md), [SqliteStore](../stores/sqlite-store.md), [SocketStore](../stores/socket-store.md) |

No lock store has a reach larger than one host. For many machines, use a lock service, for example a database lock.

## How to select a reach

1. Find all callers that write to the same thing.
2. Find the smallest reach that includes all of these callers.
3. Select a lock store with that reach.

Examples:

- One web server process that sells stock: **instance**. All requests use one `Mutex` object.
- One process with worker threads: **process**.
- A parent process that starts workers with `fork()`: **process tree**.
- Three copies of one app on one machine, started by a process manager: **host**.

## Why not always use the largest reach

A larger reach costs more:

- **Speed.** An instance lock store grants a free key before the next event loop turn. A host lock store must read or write a file first. In a test, a file `open` finished within one `setImmediate` in 22 of 50 runs. An append and a read finished in 0 of 50 runs.
- **Delay for waiters.** The file lock stores and `SqliteStore` poll. A waiter gets the key up to one `pollInterval` after the release.
- **Things on disk.** Host lock stores keep files in a directory that you give them.
- **More failure modes.** A host lock store must recover when another process stops. See [failure modes](./failure-modes.md).

## A wrong reach is a silent bug

If two callers use lock stores with no shared reach, both callers get the key. Nothing fails, and the data becomes wrong. For example, two app processes with one `MemoryStore` each can both sell the last item. The recipe [Reserve the last item](../recipes/reserve-the-last-item.md) shows the result when no lock is shared: both requests return `201`.
