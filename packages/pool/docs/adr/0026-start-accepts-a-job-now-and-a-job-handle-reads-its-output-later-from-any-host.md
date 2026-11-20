# start accepts a job now, and a JobHandle reads its output later from any host

Status: Accepted 2026-11-20 (backlog #3527). Built (2026-11-20).

`run` waits for the output ([ADR 0019](./0019-run-waits-and-a-failed-job-rejects-with-the-pools-error.md)). A host that answers `202 Accepted` must give a job id at once. Later it reads the state and the output of the job, also from another host or after a restart. With `run` only, the pool cannot do this (map, "Not yet specified").

Every leading job system has this capability:

| System                           | Accept now                                       | Read later, from any program                                            | Cancel by id                    |
| -------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------- |
| Temporal                         | `client.workflow.start` gives a `WorkflowHandle` | `client.workflow.getHandle(id).result()`; `execute` is start and result | `handle.cancel()`               |
| Celery                           | `apply_async` gives an `AsyncResult`             | `AsyncResult(id).get()` from the result backend                         | `revoke`                        |
| BullMQ                           | `queue.add` gives a `Job` with its id            | `Job.fromId(queue, id)`, then `job.waitUntilFinished(queueEvents)`      | `cancelJob`                     |
| pg-boss                          | `send` gives the id                              | `findJobs(name, { id })` until `deleteAfterSeconds`, 7 days by default  | `cancel(name, id)`              |
| Azure Asynchronous Request-Reply | `202` with `Location` and `Retry-After`          | the client reads the status resource                                    | `DELETE` on the status resource |

`@zukhruf/sqlite-queue` gives `send`, `findJobs` and `cancel` with pg-boss's meaning ("The subset" in its [README](../../../sqlite/queue/README.md)). So the store already has each part.

## Decision

From the open question "Accept a job now, and read its output later" (Ezz, 2026-11-16: "learn from memoroies what is my style and pick"). The pick follows Ezz's recorded rule for a standard package: put a capability in or out for a reason of its domain, never because no consumer needs it yet. Every leading job system has it, so the pool has it. The shape is Temporal's, because it maps one-to-one onto pg-boss.

```ts
export class Pool<Input, Output> implements AsyncDisposable {
  /** Sends the job, and resolves when the store has it. */
  start(input: Input): Promise<JobHandle<Output>>;
  /** The handle of a job of this kind that any host started. */
  handle(id: string): JobHandle<Output>;
  /** start, then result. */
  run(input: Input, options?: { signal?: AbortSignal }): Promise<Output>;
}

export interface JobHandle<Output> {
  /** The id of the job in the store. */
  readonly id: string;
  /** Waits for the output. The signal ends only this wait. */
  result(options?: { signal?: AbortSignal }): Promise<Output>;
  /** A leave for a shared job; a drop or a kill for any other job. */
  cancel(): Promise<void>;
}
```

- **`start`** sends the job and resolves with its handle, as Temporal's `start` gives a `WorkflowHandle`. The id is the id that pg-boss's `send` gives. For a shared job, `send` gives `null`, and the id is the id of the job of that key (`findJobs(name, { key })`, [ADR 0014](./0014-pool-and-pool-workers-take-one-worker-kind.md)).
- **`handle(id)`** makes a handle with no read of the store, as Temporal's `getHandle`. Any host with a `Pool` of the same kind and revision can call it.
- **`result({ signal })`** waits for the output in the same way as `run`: it listens on "an output", then reads the job with `findJobs(name, { id })` ([ADR 0018](./0018-news-travels-by-push-through-the-notify-of-the-store-with-a-backstop.md)). It rejects with the errors of [ADR 0019](./0019-run-waits-and-a-failed-job-rejects-with-the-pools-error.md). The abort of its signal ends only the wait, as the abort of a wait on a Temporal handle does not cancel the workflow.
- **`cancel()`** follows [ADR 0020](./0020-a-cancel-of-a-shared-job-is-a-leave-and-of-any-other-job-a-drop-or-a-kill.md). For a shared job it is a leave: the store does not change, and the job runs to its end for every other handle and caller. For any other job, the pool calls `cancel(name, id)` on the store. The store drops a waiting job, and the owner kills the worker of a running job at its next `touch`.
- **`run(input, { signal })`** is `start`, then `result`, as Temporal's `execute`. The abort of its signal calls `cancel()`, so `run` keeps the meaning of ADR 0020. Only `run` writes the caller's address on the job ([ADR 0021](./0021-a-caller-whose-host-is-gone-cancels-its-jobs-and-the-owner-learns-it-from-a-closed-connection.md)).
- Disposal of a `Pool` ends each `result` that waits with `DisposedError`. It cancels only the jobs of its waiting `run` calls ([ADR 0013](./0013-pool-sends-jobs-and-pool-workers-offers-the-workers-of-its-host.md)).
- Two errors join those of ADR 0019:
  - `JobCancelledError`: the job was cancelled, by `cancel()` or by the abort of a `run`. Temporal rejects with a `CancelledFailure`, and Celery with `TaskRevokedError`.
  - `JobNotFoundError`: the store has no job with the id of the handle. The job was deleted after the retention, or it belongs to another revision, or it never existed. Temporal rejects with `WorkflowNotFoundError`. A Celery `AsyncResult` of an unknown id stays `PENDING` forever, and the pool does not copy that.

## Consequences

- **The retention of the store is part of the API.** pg-boss deletes a settled job after `deleteAfterSeconds`, 7 days by default, and a job that never starts after `retentionSeconds`, 14 days. After that, `result()` rejects with `JobNotFoundError`. The pool keeps pg-boss's defaults.
- **A job that `start` sent is not tied to its starter.** A Temporal workflow outlives its starter in the same way. The job carries no caller's address, so the closed connection of ADR 0021 applies only to a `run` that waits. A host that starts a job and ends leaves the job to run. Only `cancel()` ends it.
- **A handle belongs to one revision.** Each revision has its own queue ([ADR 0022](./0022-the-newest-revision-takes-over-and-an-owner-refuses-a-job-of-an-older-revision.md)). A host of a newer revision with the id of an older job gets `JobNotFoundError`. The newer owner refuses that job anyway.
- `JobHandle`, `JobCancelledError` and `JobNotFoundError` are names of this package. Each one puts the pool's word "job" in the place of the word of the leader: Temporal's `WorkflowHandle`, `CancelledFailure` and `WorkflowNotFoundError`.
