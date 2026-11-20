# Pool and PoolWorkers take one worker kind

Status: Accepted 2026-11-20 (backlog #3527). `WorkerKind` is built (2026-11-16): its name, revision and rules, the check of its channels and its queue name. `PoolWorkers` takes it, and creates the queue of its revision with its rules. `Pool` does not take it yet.

A host that only sends must know four things about the jobs (map ticket 16):

- **The name.** Hosts that give the same name build the same pool. Different names never mix (map ticket 08, Ezz: "Yes, a required name"). A name typed twice can differ, and then the jobs wait with no owner.
- **The revision.** An owner refuses a job of an older revision ([ADR 0022](./0022-the-newest-revision-takes-over-and-an-owner-refuses-a-job-of-an-older-revision.md)). Only the sender can write the revision on the job.
- **The job rules.** pg-boss keeps them on the queue row: `retryLimit`, `expireInSeconds`, `heartbeatSeconds` and `policy`. The first `createQueue` wins, and a second one does nothing (`pg-boss/dist/plans.js:708,765`). A `send` to a queue that does not exist throws (`manager.js:857`). A host that only sends must send while no owner exists anywhere (the job waits, [ADR 0019](./0019-run-waits-and-a-failed-job-rejects-with-the-pools-error.md)), so it creates the queue, so it must create it with the same rules.
- **The types** of the input and the output.

The leading systems split here. In Temporal and BullMQ the sender gives the rules, in Celery the worker class, and in pg-boss the store. The types come from generics (BullMQ `Queue<Data, Result>` and `Worker<Data, Result>`) or from a type-only import (Temporal `proxyActivities<typeof activities>()`). The store of this pool is pg-boss, so pg-boss's rules settle the split. An Amazon SWF activity type is a name and a version that the sender names, and its registration holds the default timeouts.

## Decision

From map ticket 16, resolved 2026-11-14 by the session from precedent:

- A `WorkerKind` holds the name, the revision and the job rules, and its generics hold the types. `Pool` and `PoolWorkers` both take it, so the name is written once. A module with no native code exports it, so a host on Linux or Windows imports it with no Vision helper. The worker class (`create`) stays with `PoolWorkers` only.

```ts
export class WorkerKind<Input, Output> {
  constructor(options: {
    name: string;
    revision: number;
    policy: 'standard' | 'exclusive';
    retryLimit: number;
    expireInSeconds: number;
  });
}

export const vision = new WorkerKind<{ path: string }, { text: string }>({
  name: 'vision',
  revision: 1,
  policy: 'exclusive',
  retryLimit: 2,
  expireInSeconds: 120,
});
```

- The rule names are pg-boss's queue options, with pg-boss's meaning, because the pool writes them to the queue row as they are. Each one is required: the repository has no defaults ([ADR 0006](./0006-the-pool-evicts-an-idle-worker-that-its-eviction-lets-go-and-lends-an-idle-worker-first.md)).
- Each `Pool` and `PoolWorkers` creates the queue of its revision, `<name>.r<revision>` ([ADR 0022](./0022-the-newest-revision-takes-over-and-an-owner-refuses-a-job-of-an-older-revision.md)), with these rules, and with `heartbeatSeconds: 10` ([ADR 0017](./0017-the-owner-asks-then-takes-as-many-jobs-as-it-has-free-workers.md)).
- **Identical inputs.** The sender always gives `singletonKey`: the SHA-256 of the input. The policy decides what the key does. On an `exclusive` queue, the store keeps one job for each key in the states `created`, `retry` and `active` (`plans.js:921-922`). A second `send` of the same key then resolves `null`, and the sender waits on the job of that key (`findJobs(name, { key })`). This is a shared job. On a `standard` queue the key joins nothing (`plans.js:883-922`). So the sender needs no flag of its own.
- **A new revision** has a new queue, so it may change every rule. pg-boss forbids only a change of the policy of one queue: "queue policy cannot be changed after creation" (`manager.js:2048-2068`). The pool never calls `updateQueue`.
- **Per user.** Each user of a computer has their own pools, because the store of the computer is in that user's folder ([ADR 0015](./0015-the-store-is-a-required-input-and-computer-store-gives-the-store-of-the-computer.md); map ticket 08).
- **A host's own workers.** A worker that holds the state of one host (trashbot's Claude keeps one conversation) gets a name that only that host uses, for example one made from its state folder. Temporal gives a process its own task queue when an activity must run there (map ticket 08, Ezz: "Yes, a name of its own").
- **Settings.** Sizing, startup and eviction are the owner's: the owner uses its own while it owns. Revision, retries, the time limit and the policy are the kind's. Celery `--concurrency`, Temporal worker options and pg-boss `localConcurrency` belong to the program that runs the workers. pg-boss queue options and Temporal retry policies belong to the job type (map ticket 08).

## Consequences

- The pool does not check the input or the output at run time. A sender and an owner of the same revision run the same code, and an owner refuses another revision. BullMQ and Temporal check only types too.
- The name of a kind is short. Its two channels must be shorter than 64 bytes, and its queue name adds `.r<revision>`, which Postgres and `@zukhruf/sqlite-notify` require ([ADR 0018](./0018-news-travels-by-push-through-the-notify-of-the-store-with-a-backstop.md)). The constructor throws a `RangeError` for a longer name. The channels are `<name>.new-job` and `<name>.output`, so a name has at most 55 bytes.
