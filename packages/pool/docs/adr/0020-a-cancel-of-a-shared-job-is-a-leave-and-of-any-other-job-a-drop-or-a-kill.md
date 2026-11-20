# A cancel of a shared job is a leave, and of any other job a drop or a kill

Status: Accepted 2026-11-20 (backlog #3527). Not built.

Map ticket 07 decided that a caller's abort cancels its own job: a waiting job is dropped, and the worker of a running job is killed. A worker that serves the whole computer then dies for one caller. For Vision, the next job pays a warm start: about 1.2 s with a compile cache, 60 to 120 s after a helper rebuild (map, Revision 2026-11-13).

Map ticket 16 added shared jobs. On an `exclusive` queue, identical inputs share one job ([ADR 0014](./0014-pool-and-pool-workers-take-one-worker-kind.md)). The second `send` of the same input resolves `null` and records no caller in the store. So nobody can count the callers of a shared job, and one caller's cancel cannot know whether another caller waits.

Every system that shares one job between callers agrees (research 15, B.6). When one caller leaves, nothing changes. When every caller leaves, the job goes on:

- Temporal: `USE_EXISTING` gives a second starter the running workflow.
- BullMQ: deduplication gives a second `add` the existing job.
- Go `singleflight`: `DoChan` callers share one call; a caller that stops waiting does not stop it.
- nginx `proxy_cache_lock`: one request fills the cache, and the others wait for it.
- `@zukhruf/single-flight` ADR 0004: "a cancel withdraws only its caller".

Their cancel for every caller is a separate call that names the job: Temporal's cancel, BullMQ's `cancelJob`, Celery's `revoke`. A caller's wait is not that call.

## Decision

From map ticket 15 (Ezz, 2026-11-14: "we need to follow top perfoerms"). It narrows ticket 07 for shared jobs.

- **A shared job** (an `exclusive` kind, for example OCR): the caller's abort is a leave. Its `run` rejects with the reason of the signal, and the job runs to its end. The output stays in the store for the other callers.
- **A job that cannot be shared** (a `standard` kind, for example a transcription of a temporary file, or a Claude turn): the caller's abort is a cancel, as ticket 07 says, and as Piscina cancels a task.
  - The caller calls `cancel(name, id)` on the store. A waiting job is then `cancelled`, and the owner never fetches it.
  - A running job is `cancelled` in the store too. The owner's next `touch` does not find it under its claim, and the owner kills its worker ([ADR 0017](./0017-the-owner-asks-then-takes-as-many-jobs-as-it-has-free-workers.md)). This is pg-boss's `job.signal` (`pg-boss/dist/manager.js:536-568`), and it takes at most one touch interval, 5 s.
- **A cancel by id.** `cancel()` of a `JobHandle` follows the same two rules: a leave for a shared job, a drop or a kill for any other job ([ADR 0026](./0026-start-accepts-a-job-now-and-a-job-handle-reads-its-output-later-from-any-host.md)). The abort of a `run` calls it.
- The pool gives no cancel for every caller of a shared job. A shared job records no callers, so no host can know that it is the last one.
- Disposal of a `Pool` treats each of its waiting `run` calls in the same way ([ADR 0013](./0013-pool-sends-jobs-and-pool-workers-offers-the-workers-of-its-host.md)).

## Consequences

- A cancel never kills a worker that runs a shared job. The costly warm start of a Vision worker after a cancel goes away for OCR.
- A shared job whose callers all left still costs its run. Its output stays in the store for pg-boss's retention, 7 days ([ADR 0021](./0021-a-caller-whose-host-is-gone-cancels-its-jobs-and-the-owner-learns-it-from-a-closed-connection.md)).
- The cancel of a job that cannot be shared kills its worker. Ezz decided on 2026-11-16: "Kill only for now (Recommended)". A cancel signal on the worker's `run`, as Bazel sends `cancel: true` to a worker that declares `supports-worker-cancellation`, comes when a costly kind that cannot be shared has a worker that can cancel (README, "Decided").
