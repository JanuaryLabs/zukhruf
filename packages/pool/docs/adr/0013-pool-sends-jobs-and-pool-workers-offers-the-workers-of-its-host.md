# Pool sends jobs, and PoolWorkers offers the workers of its host

Status: Proposed 2026-11-16 for Ezz's review (backlog #3527). Not built.

A host has one of two roles, or both. Every host may send jobs. A host that has the worker program may also offer workers, and then it can own them. A context-compiler host on Linux asks for Vision reads but cannot run a Vision helper. Every leading system lets the host choose the role, and most give each role its own object (map tickets 05 and 09):

| System   | Sends                | Runs the jobs             |
| -------- | -------------------- | ------------------------- |
| Temporal | `Client`             | `Worker.create(...)`      |
| BullMQ   | `Queue`              | `Worker`                  |
| Celery   | the app, `send_task` | `celery worker -Q`        |
| Sidekiq  | the client           | the server                |
| pg-boss  | `PgBoss`, `send`     | the same `PgBoss`, `work` |

pg-boss is the only one with one object. In this package `Worker` already means the long-lived resource (see [CONTEXT.md](../../CONTEXT.md)), so the second object cannot take the precedent's name.

## Decision

From map ticket 09 (Ezz: "Pool + PoolWorkers"), with the worker kind of map ticket 16 in place of the name:

- **`Pool`** sends. `new Pool({ kind, store, clock })`. It has `run(input, { signal })` and `stats()`. It takes no sizing, startup or eviction.
- **`PoolWorkers`** offers this host's workers and may own them. `new PoolWorkers({ kind, store, clock, create, size, startup, eviction })`. It has no `run`. A host that offers workers and sends jobs builds both.
- The two meet only through the worker kind and the store, never through a reference. BullMQ's `Queue` and `Worker` meet only through the queue name in the same way. The reference of a `PoolWorkers` only marks how long this host offers its workers, and `await using` ends that. (Ezz asked "where does workers go?": nowhere.)
- `pool.stats()` resolves with the job counts of the kind in the store: `{ waiting, running }`. It is the same from every host, as BullMQ's `queue.getJobCounts()`. It reads the store, so it is a promise, not the getter of [ADR 0004](./0004-a-pool-reports-its-stats-as-one-snapshot-of-counts.md).
- `workers.stats` is the snapshot of ADR 0004 for this host's slots: `starting`, `idle`, `lent` and `waiting`. Each count is zero while this host does not own.
- `workers.ready()` resolves when this host owns and the workers that its startup starts are ready. It rejects when one of them fails to start, as today. It never resolves on a host that does not own ([ADR 0023](./0023-ownership-moves-only-by-the-owners-own-act-or-its-end-and-a-standby-stays-cold.md)).
- Disposal of a `Pool` ends each of its waiting `run` calls as a cancel ([ADR 0020](./0020-a-cancel-of-a-shared-job-is-a-leave-and-of-any-other-job-a-drop-or-a-kill.md)), and each of them rejects with `DisposedError`.
- Disposal of a `PoolWorkers` is graceful: the running jobs finish within the time limit of the kind, then the host resigns and closes its workers, as BullMQ's `worker.close()` and Temporal's `worker.shutdown()` do. A standby stops its campaign.

## Consequences

- A host on a computer that cannot run the worker program builds only a `Pool`. It never loads the worker class. A broken helper on a Mac then fails in its own warm-up ([ADR 0010](./0010-an-eager-pool-starts-a-worker-again-after-its-warm-up-fails.md)). It does not turn the host into a host that only sends.
- `pool.stats()` needs a count of the jobs of a queue by state. pg-boss has `getQueueStats(name)`. `@zukhruf/sqlite-queue` does not have it in its subset (research 20f; backlog #2888). It is a gap of the queue, and it comes before the pool, as each gap does. No host reads the stats today (map, Revision 2026-11-13).
