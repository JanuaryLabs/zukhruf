# The owner asks, then takes as many jobs as it has free workers

Status: Proposed 2026-11-16 for Ezz's review (backlog #3527). Not built.

The owner's sizing changes the number of workers while the pool runs ([ADR 0016](./0016-the-owners-sizing-caps-the-jobs-of-its-computer.md)). pg-boss's `work(name, options, handler)` fixes `localConcurrency` and `batchSize` when it is called, and polls at least every 500 ms. With a fixed count above the size of the pool, the store gives the owner jobs that it cannot start. A fetched job is `active` in the store, so `pool.stats()` counts it as running. When the owner dies, such a job uses one of its retries although no worker ran it, and a kind with no retries loses a job that never started (map ticket 17).

Every system that changes its size at run time by its own measure asks for its free room first, and then takes that many jobs (research 17):

- Temporal reserves a slot before it polls (slot suppliers, the resource-based tuner).
- BullMQ fetches while its running and fetching jobs are below `concurrency`, a value that can change at run time.
- Celery with `worker_disable_prefetch`, and Solid Queue, claim only the free room.
- pg-boss's own `work` is a loop of `fetch`, then `complete` or `fail` (`pg-boss/dist/manager.js:951-956`).

## Decision

From map tickets 17 and 12:

- The owner calls `fetch(name, { batchSize: free })` on the queue of its own revision ([ADR 0022](./0022-the-newest-revision-takes-over-and-an-owner-refuses-a-job-of-an-older-revision.md)). `free` is the number of slots that the sizing runs and that have no job.
- The owner settles each job by its attempt: `complete` with the output, or `fail` with the failure as data ([ADR 0019](./0019-run-waits-and-a-failed-job-rejects-with-the-pools-error.md)). The store fences a settle by the attempt. A result with `affected: 0` means that the owner lost the claim, and the owner drops its output (research 20f: 361,800 of 361,800 settles fenced right).
- The owner fetches at three times: when a worker becomes free, at a "new job" wake, and at the backstop ([ADR 0018](./0018-news-travels-by-push-through-the-notify-of-the-store-with-a-backstop.md)).
- **Heartbeats.** The queue of each revision of a kind has `heartbeatSeconds: 10`, the least that pg-boss accepts (`attorney.js:578`). The owner calls `touch` for each running job every 5 s, half the heartbeat, as pg-boss's `work` does (`manager.js:538`). Each store instance runs its monitor every second (`monitorIntervalSeconds: 1`). A job of a dead owner thus goes back to `retry`, or fails, about 11 s after its last touch (map ticket 12).
- **The time limit.** The owner kills the worker of a job that runs longer than the kind's `expireInSeconds`, and fails the job. The store's monitor fails such a job too. The two settles meet the fence of the attempt, so only one counts.
- **A cancel from the store.** A `touch` that does not find the job under the owner's claim tells the owner that the job is gone, for example cancelled by its caller. The owner then kills the worker of that job. This is how pg-boss aborts `job.signal` in `work` (`manager.js:536-568`).

Ezz approved the gap on 2026-11-13: "Alright, let's do this. Just make sure that SQLite queue is meant to be 1:1 with pg boss". `fetch` and `complete` are built in `@zukhruf/sqlite-queue` (#4313), and `touch` too (#4370), each with its parity tests.

## Consequences

- The same owner code runs on pg-boss across computers.
- A fetched job counts as running in the store (`plans.js:2019-2023`), and only jobs that a worker can start are fetched.
- The wait between jobs is the pool's own. pg-boss's `NOTIFY` wakes only the loops of `work` (`notifier.js`), so the pool listens on its own channels.
- A job that the owner holds when it dies waits for its heartbeat, not for `expireInSeconds`.
- The owner shuts down in this order: it stops fetching, finishes and settles its running jobs, and then resigns.
