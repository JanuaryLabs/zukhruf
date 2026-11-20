# The newest revision takes over, and an owner refuses a job of an older revision

Status: Accepted 2026-11-20 (backlog #3527). Not built.

Old plugin servers run on after an update (#2127). Hosts of two revisions of one worker kind then share one pool. `@zukhruf/election` never moves ownership while the owner lives, so an old owner keeps the workers until it ends (map ticket 08).

Two known ways handle a job of another version (research 16, corrected by research 20g):

- **Route or branch by version.** Temporal routes a task to a worker by its build id. GitLab on Sidekiq writes a version on the job, and the worker branches on it.
- **Refuse.** Azure Durable Task: a client states the version of an orchestration, and a worker with the `Strict` match does not run another version; with `Reject` (the default) "The orchestration is rejected and returned to the work queue. Another worker can attempt it later". Amazon SWF: an activity type is a name and a version that the sender names, and the service refuses a version that is deprecated (`ACTIVITY_TYPE_DEPRECATED`).

In both systems that refuse, the sender states the version.

## Decision

From map ticket 08 (Ezz: "Newest takes over", "ruthless", "Yes, reject old jobs", "A revision number") and map ticket 16. The queue for each revision was decided on 2026-11-16 by the leaders (Ezz: "I trust your recommendation ... follow the top performers"):

- **The revision** is an integer of the worker kind ([ADR 0014](./0014-pool-and-pool-workers-take-one-worker-kind.md)). The author raises it only when `run` changes in a way that matters. "Newer" means a higher integer.
- **A queue for each revision.** The queue of a kind in the store is `<name>.r<revision>`, for example `vision.r1`. A `Pool` sends to the queue of its revision, and an owner fetches only from the queue of its own revision. So an older owner never fetches a job of a newer revision. Temporal worker versioning routes each task by its build id, and Amazon SWF routes by the version of the activity type, in the same way: at the poll, not after it.
- **The wake carries the revision.** The payload of "a new job" is the revision of the job ([ADR 0018](./0018-news-travels-by-push-through-the-notify-of-the-store-with-a-backstop.md)). The channel stays one for each kind, so the owner hears the jobs of every revision. A `Pool` whose job waits sends this wake again at each backstop, so a wake that was lost cannot hide a revision.
- **An owner refuses a job of an older revision.** At a wake with an older revision, it fetches from the queue of that revision and settles each job with `complete`. The output records the refusal, so no retry runs the job again. The sender's `run`, and each `result` of the job, rejects with `DeprecatedRevisionError`, which tells the host to update. No compatibility is promised between revisions.
- **An owner that hears a wake of a newer revision** fetches nothing from that queue. It finishes its running jobs within the kind's time limit and resigns, so a host of the newer revision wins the election. This is the clean hand-over of [ADR 0023](./0023-ownership-moves-only-by-the-owners-own-act-or-its-end-and-a-standby-stays-cold.md).
- A `PoolWorkers` that resigned for a newer revision does not campaign again while it lives. Otherwise it could win again, see the newer job again, and resign again without end. (Derived from the two lines above; Ezz can overrule.)
- **Many computers**: the same name in the shared store is the same pool on every computer. The hand-over runs on each computer, and the refusal applies wherever an owner runs.

## Consequences

- During an update, the jobs of the old hosts fail with `DeprecatedRevisionError` as soon as a new owner runs. The old hosts end at the next start of their programs.
- Each revision creates its own queue with its own rules, so a new revision may change every rule, the policy too ([ADR 0014](./0014-pool-and-pool-workers-take-one-worker-kind.md)). Identical inputs of two revisions are two jobs.
- A job of a newer revision never uses a retry in an older owner. pg-boss has no call that puts an active job back with no cost, as Durable Task's `Reject` does, and with a queue for each revision the pool needs none.
- The queues of older revisions stay in the store as empty rows. `pool.stats()` counts the queue of its own revision.
- The suffix `.r<revision>` is a name of this package. pg-boss allows a period in a queue name (`attorney.js`, `assertObjectName`).
