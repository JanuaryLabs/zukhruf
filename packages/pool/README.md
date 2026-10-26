# @zukhruf/pool

Lends long-lived workers to jobs, one job for each worker at a time. A worker is costly to start: a native helper that loads a model, or a command-line agent that keeps a session. The pool starts workers, lends them, replaces a worker that exits, and stops all of them when you dispose it. You choose two things from standard classes: when the workers start (a startup) and how many run (a sizing).

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Lend a worker to a job

```ts
import { Fixed, Parallel, Pool } from '@zukhruf/pool';

await using pool = new Pool({
  size: new Fixed(2),
  startup: new Parallel(),
  create: () => new VisionWorker('/path/to/vision-worker'),
});
const text = await pool.use((worker) => worker.read('/tmp/receipt.png'));
```

A worker gives `exited()`, `kill()`, `close()`, and optionally `ready()`. A `Coprocess` of `@zukhruf/coprocess` has all of them. When a signal aborts a job that runs, the pool kills its worker. When a signal aborts a job whose worker still warms up, the warm-up continues for the next job.

## Choose when the workers start

| Startup        | Starts                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OnDemand`     | a worker only when a job needs one                                                                                                                         |
| `Parallel`     | every worker when you build the pool, all together                                                                                                         |
| `OrderedReady` | every worker when you build the pool, one after the other, as Kubernetes starts an `OrderedReady` StatefulSet                                              |
| `LeaderFirst`  | the first worker alone, and the others together when it is ready. Use it when the first worker fills a cache that the others read, such as compiled models |

## Choose how many workers run

| Sizing                              | Runs                                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `Fixed(n)`                          | n workers                                                                                                              |
| `Resources({ memoryPerWorker })`    | one for each CPU, while each finds its memory free                                                                     |
| `HillClimbing({ memoryPerWorker })` | two first, and one more while the last one added at least a tenth more jobs a second (as the .NET thread pool)         |
| `Gradient({ memoryPerWorker })`     | two first, and one more while a job takes at most half again the time it took with two (as Netflix concurrency-limits) |

The two sizings that learn measure only while jobs wait and every worker is ready, in windows of at least 20 jobs and 2 seconds. They learn once, and never pass what the computer can give. See [ADR 0002](./docs/adr/0002-a-sizing-that-learns-compares-one-more-worker-between-two-windows.md).

## Decisions

- [ADR 0001](./docs/adr/0001-startups-and-sizings-are-classes-that-a-caller-chooses.md): startups and sizings are classes that a caller chooses.
- [ADR 0002](./docs/adr/0002-a-sizing-that-learns-compares-one-more-worker-between-two-windows.md): a sizing that learns compares one more worker between two windows.
- [ADR 0003](./docs/adr/0003-the-pool-learns-that-a-worker-ended-from-its-exit.md): the pool learns that a worker ended from its exit.
