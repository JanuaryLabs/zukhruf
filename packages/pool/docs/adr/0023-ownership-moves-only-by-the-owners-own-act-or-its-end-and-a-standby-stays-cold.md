# Ownership moves only by the owner's own act or its end, and a standby stays cold

Status: Accepted 2026-11-20 (backlog #3527). Partly built in `PoolWorkers` (2026-11-16): the cold standby, the return of a dead owner's jobs by their heartbeat, and the disposal that stops fetching, finishes the running jobs, resigns and then closes the workers. A running job ends at the latest at the kind's time limit, so the disposal ends too. `ready()` is built (2026-11-20): it never resolves on a standby. The hand-over to a host of a newer revision is built with [ADR 0022](./0022-the-newest-revision-takes-over-and-the-store-deprecates-every-older-revision.md) (2026-11-27).

Ownership moves in four ways (map ticket 12):

- The owner's host exits.
- The owner's host disposes its `PoolWorkers`.
- The owner resigns for a host of a newer revision ([ADR 0022](./0022-the-newest-revision-takes-over-and-the-store-deprecates-every-older-revision.md)).
- The owner's host dies or hangs, and a standby takes over ([ADR 0024](./0024-a-hung-owner-is-ended-by-the-election-and-its-late-acts-are-fenced.md)).

A Vision worker takes 2 GiB and compiles through the one `ANECompilerService` of the computer (#3868). Its warm start takes about 1.2 s with a compile cache, and 60 to 120 s after a helper rebuild.

Every system that keeps a standby warm keeps a copy of data warm, never the capped resource (research 12-13): controller-runtime warms its caches on a standby and starts its work only after the election; Postgres and Redis replicas keep the log; Kafka Streams keeps state stores, and its `num.standby.replicas` defaults to 0. Here the capped resource is the worker itself.

## Decision

From map ticket 12, resolved 2026-11-14 by the session from precedent:

- **Cold standby.** A standby host starts no workers until it owns. A new owner pays a warm start. The jobs wait in the store meanwhile.
- **A clean hand-over.** The owner stops fetching, finishes its running jobs within the kind's time limit, settles them, resigns, and closes its workers ([ADR 0013](./0013-pool-sends-jobs-and-pool-workers-offers-the-workers-of-its-host.md)), as BullMQ's `close()` and Temporal's shutdown do within their grace time. The waiting jobs stay in the store for the next owner. A host that exits on a termination signal disposes its `PoolWorkers` first, through `@zukhruf/shutdown`.
- **An owner that dies.** Its fetched jobs are `active`. They come back by pg-boss's heartbeat and run again by the kind's rules ([ADR 0017](./0017-the-owner-asks-then-takes-as-many-jobs-as-it-has-free-workers.md)), as pg-boss, BullMQ and Temporal do. Solid Queue fails them instead. A kind with no retries fails, and its caller gets `JobFailedError`.
- **A short-lived owner**, for example a CLI run, may own, as any host may. A living owner moves only by its own act: its clean exit, or a host of a newer revision. No priority between hosts exists: client-go, ZooKeeper, Consul and Redis Sentinel have none for a living holder. Kubernetes `preferredHolder` (beta) and RabbitMQ's quorum priority only signal the holder, which yields. No host of the pool needs it.
- **`ready()`** never resolves on a host that does not own, as controller-runtime's `Elected()` never closes on a standby.

## Consequences

- After the owner moves, the first job waits for a warm start.
- A short-lived owner that ends soon moves ownership again soon. Each move costs a warm start.
- A new owner starts its sizing fresh ([ADR 0016](./0016-the-owners-sizing-caps-the-jobs-of-its-computer.md)).
