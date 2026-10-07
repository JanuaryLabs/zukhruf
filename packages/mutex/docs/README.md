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
10. [Compute a value once and share it](./recipes/compute-once-and-share-it.md)

## Architecture decision records

1. [Every process is a candidate](./adr/0001-every-process-is-a-candidate.md)
2. [Leader election is not part of the mutex](./adr/0002-election-is-not-part-of-the-mutex.md)
3. [A fencing token on every lease](./adr/0003-a-fencing-token-on-every-lease.md)
4. [When the parent stops, held keys stay held](./adr/0004-parent-stops-held-keys-stay.md)
5. [Threads use a coordinator, not Web Locks](./adr/0005-threads-use-a-coordinator-not-web-locks.md)
6. [Acquire modes are strategies over two lock store operations](./adr/0006-acquire-modes-are-strategies-over-two-store-operations.md)
7. [The connection to a coordinator is separate from the lock requests](./adr/0007-the-connection-is-separate-from-the-lock-requests.md)
8. [A caller cancels with a signal; an acquire mode gives up](./adr/0008-a-caller-cancels-an-acquire-mode-gives-up.md)
9. [A phase is a state object, a latch, or an event](./adr/0009-a-phase-is-a-state-object-a-latch-or-an-event.md)
10. [The time limit of skip if busy counts only the wait for a holder](./adr/0010-the-time-limit-of-skip-if-busy-counts-only-the-wait-for-a-holder.md)
11. [A Windows refusal of a lock file is tried again for a limited time](./adr/0011-a-windows-refusal-of-a-lock-file-is-tried-again-for-a-limited-time.md)
12. [A file store holder is judged by its presence](./adr/0012-a-file-store-holder-is-judged-by-its-presence.md)
13. [A lost lease aborts the signal of the lease](./adr/0013-a-lost-lease-aborts-the-signal-of-the-lease.md)
14. [A process says its protocol version before its first request](./adr/0014-a-process-says-its-protocol-version-before-its-first-request.md)
15. [A holder check never acquires the key](./adr/0015-a-holder-check-never-acquires-the-key.md)
16. [A leader lists the requests that it added](./adr/0016-a-leader-lists-the-requests-that-it-added.md)
