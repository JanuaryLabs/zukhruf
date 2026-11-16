# run waits, and a failed job rejects with the pool's error

Status: Proposed 2026-11-16 for Ezz's review (backlog #3527). Not built.

A host that gives the pool a job needs to know what it gets and when (map ticket 07). Today's callers wait: elt's `ImageFormat.text(path, signal)` awaits `pool.use(…)`. A job can also fail in new ways: a worker exits during the job, a job fails all its retries, the owner stops, or no owner exists.

## Decision

From map ticket 07, resolved with Ezz on 2026-11-03 (each line was Ezz's pick of the recommended option), and ticket 15 for the input file:

- **`run` waits.** `await pool.run(input, { signal })` resolves with the output, as Piscina's `run` and Temporal's `execute` do. `run` is `start`, then `result`. `start` accepts a job now, and its `JobHandle` reads the output later, from any host ([ADR 0026](./0026-start-accepts-a-job-now-and-a-job-handle-reads-its-output-later-from-any-host.md)). The rules below apply to `run` and to `result` alike.
- **Retries belong to the worker kind** (`retryLimit`, [ADR 0014](./0014-pool-and-pool-workers-take-one-worker-kind.md)), as pg-boss keeps `retryLimit` on the queue and Temporal a retry policy on each activity. Vision OCR runs again: it gives the same text. A Claude turn never runs again: it would send the prompt twice. `run` and `result` reject only after the retries.
- **Two time limits.** The kind's `expireInSeconds` limits one run of a job, and the owner kills the worker at that limit ([ADR 0017](./0017-the-owner-asks-then-takes-as-many-jobs-as-it-has-free-workers.md)). The caller's `signal` limits only how long the caller waits.
- **No owner anywhere.** When no computer runs a worker of the kind, the job waits in the store until an owner comes or the caller's signal aborts, as Celery and pg-boss jobs wait for a worker. `pool.stats()` shows it as waiting.
- **A failure travels as data.** The owner fails the job with the worker's error name and message, as pg-boss stores `{ message, stack }` as the output of a failed job and Temporal sends an `ApplicationFailure`. `run` and `result` reject with `JobFailedError`, which carries that name and message. It never rejects with the worker's own class: the pool owns its errors.
- **An input file that is gone** is the worker's own failure, as data, retried by the kind's rule. Temporal fails and retries the attempt, the SQS Extended Client retries by default, and a Bazel persistent worker answers with a nonzero `exit_code` (map ticket 15). A missing file fails fast, so a retry costs little.

| Error                     | When `run` or `result` rejects with it                                                                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JobFailedError`          | The job failed its last run: the worker failed, the worker exited, the time limit ended, or the owner stopped and its heartbeat ended. Its `failure` has the name and the message of the failure.               |
| `DeprecatedRevisionError` | The owner refused the job, because the host sent it with an older revision of the kind. Update the host ([ADR 0022](./0022-the-newest-revision-takes-over-and-an-owner-refuses-a-job-of-an-older-revision.md)). |
| `DisposedError`           | The host disposed its `Pool` while the `run` or the `result` waited.                                                                                                                                            |
| `JobCancelledError`       | The job was cancelled, by `cancel()` of a handle or by the abort of a `run` ([ADR 0026](./0026-start-accepts-a-job-now-and-a-job-handle-reads-its-output-later-from-any-host.md)).                              |
| `JobNotFoundError`        | The store has no job with the id of the handle: it was deleted after the retention, it belongs to another revision, or it never existed (ADR 0026).                                                             |
| The reason of `signal`    | The caller's signal aborted ([ADR 0020](./0020-a-cancel-of-a-shared-job-is-a-leave-and-of-any-other-job-a-drop-or-a-kill.md)).                                                                                  |

The names come from the leading systems where one exists: `DeprecatedRevisionError` after Amazon SWF's `ACTIVITY_TYPE_DEPRECATED`, and `DisposedError` after `@zukhruf/sqlite-notify`. `JobFailedError` is the name of map ticket 07. ADR 0026 names `JobCancelledError` and `JobNotFoundError`.

## Consequences

- The errors of the store stay inside the pool. A host examines the pool's classes only.
- A host that needs the output of a job after its own host ends uses `start` and `handle(id)`, not `run`. The job of a `run` is cancelled when its host is gone ([ADR 0021](./0021-a-caller-whose-host-is-gone-cancels-its-jobs-and-the-owner-learns-it-from-a-closed-connection.md)), and the job of a `start` is not (ADR 0026).
