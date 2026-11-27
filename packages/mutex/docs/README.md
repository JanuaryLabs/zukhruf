# Documentation

Start with the [project README](../README.md). The glossary is in [CONTEXT.md](../CONTEXT.md).

## Concepts

- [Reach](./concepts/reach.md)
- [Acquire modes](./concepts/acquire-modes.md)
- [Fencing tokens](./concepts/fencing-tokens.md)
- [Leader election](../../election/docs/concepts/leader-election.md), in `@zukhruf/election`
- [Failure modes](./concepts/failure-modes.md)

## Lock stores

| Reach        | Lock store                                                                                                                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instance     | [MemoryStore](./stores/memory-store.md)                                                                                                                                                                                            |
| Process      | [ThreadStore and ThreadLockCoordinator](./stores/thread-store.md)                                                                                                                                                                  |
| Process tree | [IpcStore and IpcLockCoordinator](./stores/ipc-store.md)                                                                                                                                                                           |
| Host         | [TicketQueueFileStore](./stores/ticket-queue-file-store.md), [LockFileStore](./stores/lock-file-store.md), [SqliteStore](./stores/sqlite-store.md), [SocketStore](./stores/socket-store.md)                                        |
| Network      | [PostgresStore](./stores/postgres-store.md), [SqlServerStore](./stores/sqlserver-store.md), [MysqlStore](./stores/mysql-store.md), [MariadbStore](./stores/mariadb-store.md), [DockerEngineStore](./stores/docker-engine-store.md) |

## Recipes

1. [Stop two requests from selling the last item](./recipes/reserve-the-last-item.md)
2. [Several app instances on one host](./recipes/several-instances-on-one-host.md)
3. [A worker pool that you start](./recipes/worker-pool.md)
4. [Worker threads that share a lock](./recipes/worker-threads.md)
5. [Protect a database from stale holders](./recipes/fence-a-database.md)
6. [Survive a crashed holder](./recipes/survive-a-crashed-holder.md)
7. [Run a job in only one process](../../election/docs/recipes/run-a-job-in-only-one-process.md), a recipe of `@zukhruf/election`
8. [Write your own lock store](./recipes/write-your-own-lock-store.md)
9. [Skip a job that is already running](./recipes/skip-a-job-that-is-already-running.md)
10. [Compute a value once and share it](./recipes/compute-once-and-share-it.md)
11. [Hold several keys for one run, or skip the run](./recipes/hold-several-keys-or-none.md)

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
14. [A process says its protocol version before its first request](./adr/0014-a-process-says-its-protocol-version-before-its-first-request.md) (superseded in part by ADR 0033)
15. [A holder check never acquires the key](./adr/0015-a-holder-check-never-acquires-the-key.md)
16. [A leader lists the requests that it added](./adr/0016-a-leader-lists-the-requests-that-it-added.md) (superseded by ADR 0014)
17. [A connection closes only when its framing breaks](./adr/0017-a-connection-closes-only-when-its-framing-breaks.md)
18. [The next leader skips the grace window after a clean shutdown](./adr/0018-the-next-leader-skips-the-grace-window-after-a-clean-shutdown.md) (superseded in part by ADR 0033)
19. [A failed token mint answers the request, and an exhausted epoch ends the term](./adr/0019-a-failed-token-mint-answers-the-request-and-an-exhausted-epoch-ends-the-term.md)
20. [Each family of lock stores has its own import path](./adr/0020-each-store-family-has-its-own-import-path.md)
21. [A lock store can reach every machine that reaches one server](./adr/0021-a-lock-store-can-reach-every-machine-that-reaches-one-server.md)
22. [A database lock store takes its session from the caller](./adr/0022-a-database-lock-store-takes-its-session-from-the-caller.md)
23. [A Postgres waiter is cancelled by closing its session](./adr/0023-a-postgres-waiter-is-cancelled-by-closing-its-session.md)
24. [A SQL Server holder check reads the lock view](./adr/0024-a-sql-server-holder-check-reads-the-lock-view.md) (superseded by ADR 0035)
25. [A MySQL-family lock belongs to one database](./adr/0025-a-mysql-family-lock-belongs-to-one-database.md)
26. [A Docker engine key is a named container that lives while its holder attaches](./adr/0026-a-docker-engine-key-is-a-named-container-that-lives-while-its-holder-attaches.md)
27. [Docker engine tokens come from a ladder of named volumes](./adr/0027-docker-engine-tokens-come-from-a-ladder-of-named-volumes.md)
28. [A Docker engine token is the higher of the engine time and the ladder](./adr/0028-a-docker-engine-token-is-the-higher-of-the-engine-time-and-the-ladder.md)
29. [A Docker engine store marks its claims and rungs with the labels of the caller](./adr/0029-a-docker-engine-store-marks-its-claims-and-rungs-with-the-labels-of-the-caller.md)
30. [Each lock store runs the lock-store contract from its own tests, and a capability is a typed parameter](./adr/0030-each-lock-store-runs-the-lock-store-contract-from-its-own-tests-and-a-capability-is-a-typed-parameter.md)
31. [A follower observes the leader, so a frozen leader is ended](./adr/0031-a-follower-observes-the-leader-so-a-frozen-leader-is-ended.md) (superseded in part by ADR 0033)
32. [A cancelled waiter of the memory store leaves the line](./adr/0032-a-cancelled-waiter-of-the-memory-store-leaves-the-line.md)
33. [A new leader grants nothing until each recorded session reasserted its keys, stopped, or missed its lease](./adr/0033-a-new-leader-grants-nothing-until-each-recorded-session-reasserted-its-keys-stopped-or-missed-its-lease.md)
34. [A leader selector of the mutex runs a task each time it leads, and requeues as Apache Curator does](./adr/0034-a-leader-selector-of-the-mutex-runs-a-task-each-time-it-leads-and-requeues-as-apache-curator-does.md) (superseded by `@zukhruf/election` ADR 0011)
35. [A SQL Server key is a lease that ends unless its holder renews it](./adr/0035-a-sql-server-key-is-a-lease-that-ends-unless-its-holder-renews-it.md)
36. [A key is a backend of leader election](./adr/0036-a-key-is-a-backend-of-leader-election.md)

## Copied code

- [Code that is in two places](./copied-code.md): each copy, what is the same, and what differs.
