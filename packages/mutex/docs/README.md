# Documentation

Start with the [project README](../README.md). The glossary is in [CONTEXT.md](../CONTEXT.md).

## Concepts

- [Reach](./concepts/reach.md)
- [Acquire modes](./concepts/acquire-modes.md)
- [Fencing tokens](./concepts/fencing-tokens.md)
- [Leader election](./concepts/leader-election.md)
- [Failure modes](./concepts/failure-modes.md)

## Lock stores

| Reach        | Lock store                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instance     | [MemoryStore](./stores/memory-store.md)                                                                                                                                                     |
| Process      | [ThreadStore and ThreadLockCoordinator](./stores/thread-store.md)                                                                                                                           |
| Process tree | [IpcStore and IpcLockCoordinator](./stores/ipc-store.md)                                                                                                                                    |
| Host         | [TicketQueueFileStore](./stores/ticket-queue-file-store.md), [LockFileStore](./stores/lock-file-store.md), [SqliteStore](./stores/sqlite-store.md), [SocketStore](./stores/socket-store.md) |

## Recipes

1. [Stop two requests from selling the last item](./recipes/reserve-the-last-item.md)
2. [Several app instances on one host](./recipes/several-instances-on-one-host.md)
3. [A worker pool that you start](./recipes/worker-pool.md)
4. [Worker threads that share a lock](./recipes/worker-threads.md)
5. [Protect a database from stale holders](./recipes/fence-a-database.md)
6. [Survive a crashed holder](./recipes/survive-a-crashed-holder.md)
7. [Run a job in only one process](./recipes/singleton-job-with-leader-election.md)
8. [Write your own lock store](./recipes/write-your-own-lock-store.md)
9. [Skip a job that is already running](./recipes/skip-a-job-that-is-already-running.md)

## Architecture decision records

1. [Every process is a candidate](./adr/0001-every-process-is-a-candidate.md)
2. [Leader election is not part of the mutex](./adr/0002-election-is-not-part-of-the-mutex.md)
3. [A fencing token on every lease](./adr/0003-a-fencing-token-on-every-lease.md)
4. [When the parent stops, held keys stay held](./adr/0004-parent-stops-held-keys-stay.md)
5. [Threads use a coordinator, not Web Locks](./adr/0005-threads-use-a-coordinator-not-web-locks.md)
6. [Acquire modes are strategies over two lock store operations](./adr/0006-acquire-modes-are-strategies-over-two-store-operations.md)
7. [The connection to a coordinator is separate from the lock requests](./adr/0007-the-connection-is-separate-from-the-lock-requests.md)
