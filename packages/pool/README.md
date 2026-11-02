# @zukhruf/pool

Lends long-lived workers to jobs, one job for each worker at a time. A worker is costly to start: a native helper that loads a model, or a command-line agent that keeps a session. The pool starts workers, lends them, replaces a worker that exits, and stops all of them when you dispose it. You choose three things from standard classes: when the workers start (a startup), how many run (a sizing), and when an idle worker closes (an eviction).

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Lend a worker to a job

```ts
import { Fixed, IdleTimeout, Parallel, Pool } from '@zukhruf/pool';

await using pool = new Pool({
  size: new Fixed(2),
  startup: new Parallel(),
  eviction: new IdleTimeout({ after: 300_000 }),
  create: () => new VisionWorker('/path/to/vision-worker'),
});
const text = await pool.use((worker) => worker.read('/tmp/receipt.png'));
```

A worker gives `exited()`, `kill()`, `close()`, and optionally `ready()`. A `Coprocess` of `@zukhruf/coprocess` has all of them.

A job takes an idle worker first. When no worker is idle, the job takes a worker that starts. Only when no worker starts does the job start a new worker. Of the idle workers, a job takes the one in the lowest slot. Thus jobs one at a time use one worker, and the other idle workers stay idle until their eviction lets them go.

When a signal aborts a job that runs, the pool kills its worker. When a signal aborts a job whose worker still warms up, the warm-up continues for the next job.

The pool waits for `ready()` with no time limit. Thus, if the warm-up of a worker can wait forever, the worker sets its own time limit, and `ready()` rejects when that limit ends. The pool then kills and closes the worker, and the job that waits for it fails. The next job starts a new worker.

## Choose when the workers start

| Startup        | Starts                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OnDemand`     | a worker only when a job needs one                                                                                                                         |
| `Parallel`     | every worker when you build the pool, all together                                                                                                         |
| `OrderedReady` | every worker when you build the pool, one after the other, as Kubernetes starts an `OrderedReady` StatefulSet                                              |
| `LeaderFirst`  | the first worker alone, and the others together when it is ready. Use it when the first worker fills a cache that the others read, such as compiled models |

## Choose how many workers run

| Sizing                              | Runs                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `Fixed(n)`                          | n workers                                                                                                           |
| `Resources({ memoryPerWorker })`    | one for each CPU, while each finds its memory free                                                                  |
| `HillClimbing({ memoryPerWorker })` | two first, then as many as add at least a tenth more jobs a second each (as the .NET thread pool)                   |
| `Gradient({ memoryPerWorker })`     | two first, then as many as keep a job at most half again the time it takes with two (as Netflix concurrency-limits) |

The two sizings that learn take steps for as long as the pool runs. A step measures three windows of at least 20 jobs and 2 seconds: at the size it has, at the size it tries, and at the size it has again. A sizing measures only while jobs wait and every worker is ready.

- A step tries one more worker, or fewer: `HillClimbing` one fewer, `Gradient` two. A step with fewer keeps every worker alive, so it costs no warm-up.
- The sizing keeps one more worker as soon as one step shows that it pays. It lets a worker go only after two steps in a row show that the worker does not pay.
- After a step that changes nothing, the sizing pauses: one window first, then twice as long after each such step, up to 16 windows. The length is random, so pools in other processes do not step at the same moments.
- After each window, the sizing reads the free memory again. When its workers do not fit, it runs fewer at once. It never runs more than the capacity when the pool was built.

See [ADR 0002](./docs/adr/0002-a-sizing-that-learns-compares-one-more-worker-between-two-windows.md) and [ADR 0007](./docs/adr/0007-a-sizing-that-learns-keeps-learning-in-steps-both-ways-and-pauses-between-steps-that-change-nothing.md).

## Choose when idle workers close

| Eviction                 | Evicts                                                       |
| ------------------------ | ------------------------------------------------------------ |
| `NoEviction`             | no worker. Each idle worker stays until you dispose the pool |
| `IdleTimeout({ after })` | a worker that stays idle for `after` milliseconds            |

A job that takes the worker before `after` ends keeps it. When the job ends, a new `after` starts. `after` is a number of milliseconds above 0 and at most 2,147,483,647. Another value throws a `RangeError`, because Node runs a timer with a larger delay after 1 ms.

Mature pools give these idle times: the .NET thread pool 20 s, generic-pool 30 s, KEDA and the Kubernetes HPA 300 s before they scale down, and HikariCP 10 minutes. A worker that is costly to start, such as a helper that loads a model, needs a long time. A worker that holds much memory needs a short time.

The pool evicts only a worker in a slot that the sizing runs. A worker that the sizing keeps but does not run stays alive for the next step of the sizing ([ADR 0002](./docs/adr/0002-a-sizing-that-learns-compares-one-more-worker-between-two-windows.md)). The next job that needs an evicted slot starts a new worker. See [ADR 0006](./docs/adr/0006-the-pool-evicts-an-idle-worker-that-its-eviction-lets-go-and-lends-an-idle-worker-first.md).

## Read the stats

A host can ask the pool how its workers are, for example in a health check:

```ts
const { starting, idle, lent, waiting } = pool.stats;
const healthy = waiting === 0 || starting + idle + lent > 0;
```

| Count      | Is                                                                         |
| ---------- | -------------------------------------------------------------------------- |
| `starting` | the workers that start and are not ready yet                               |
| `idle`     | the ready workers that no job has                                          |
| `lent`     | the ready workers that a job has                                           |
| `waiting`  | the jobs that wait for a worker: in the queue, or for a worker that starts |

A worker that exited is in no count, and a slot whose worker the pool evicted is in no count. Thus a pool with an eviction can show zero in each count and be healthy: the next job starts a worker. Each read makes a new object, so the counts of one read agree with each other. See [ADR 0004](./docs/adr/0004-a-pool-reports-its-stats-as-one-snapshot-of-counts.md).

## Replace a worker that exits

A job that needs the slot of an exited worker starts a new worker. An eager startup also replaces an idle worker that exits. After an early exit (a worker that ran less than 10 minutes), the pool waits first: 1 s, then 2 s, 4 s, and so on up to 60 s for each early exit in a row. A worker that runs 10 minutes ends this back-off. A job does not wait for a back-off: its worker starts now. Kubernetes restarts a container in CrashLoopBackOff with the same rule. The pool does not count an evicted worker as an exit: it does not replace the worker and does not start a back-off. An evicted worker that ran 10 minutes ends the back-off too. See [ADR 0005](./docs/adr/0005-an-eager-pool-backs-off-before-it-replaces-a-worker-that-exited-early.md).

## Recipes

1. [Let the pool find how many workers pay](./docs/recipes/find-how-many-workers-pay.md)
2. [Warm a model once, then start the other workers](./docs/recipes/warm-a-model-once.md)
3. [Hold workers only while there is work](./docs/recipes/hold-workers-only-while-there-is-work.md)
4. [Test a pool on the real path](./docs/recipes/test-a-pool-on-the-real-path.md)

## Decisions

- [ADR 0001](./docs/adr/0001-startups-and-sizings-are-classes-that-a-caller-chooses.md): startups and sizings are classes that a caller chooses.
- [ADR 0002](./docs/adr/0002-a-sizing-that-learns-compares-one-more-worker-between-two-windows.md): a sizing that learns compares one more worker between two windows.
- [ADR 0003](./docs/adr/0003-the-pool-learns-that-a-worker-ended-from-its-exit.md): the pool learns that a worker ended from its exit.
- [ADR 0004](./docs/adr/0004-a-pool-reports-its-stats-as-one-snapshot-of-counts.md): a pool reports its stats as one snapshot of counts.
- [ADR 0005](./docs/adr/0005-an-eager-pool-backs-off-before-it-replaces-a-worker-that-exited-early.md): an eager pool backs off before it replaces a worker that exited early.
- [ADR 0006](./docs/adr/0006-the-pool-evicts-an-idle-worker-that-its-eviction-lets-go-and-lends-an-idle-worker-first.md): the pool evicts an idle worker that its eviction lets go, and lends an idle worker first.
- [ADR 0007](./docs/adr/0007-a-sizing-that-learns-keeps-learning-in-steps-both-ways-and-pauses-between-steps-that-change-nothing.md): a sizing that learns keeps learning in steps both ways, and pauses between steps that change nothing.
