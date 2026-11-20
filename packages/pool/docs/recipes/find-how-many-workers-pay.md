# Recipe: Let the pool find how many workers pay

**Use case.** A helper reads the text in images. You do not know how many helpers to run. The answer depends on the computer, on the images, and on the other processes that run. `Fixed(n)` is a guess. `Resources` runs one worker for each CPU, also when the jobs wait for something that the workers share. A sizing that learns measures how many workers pay, and measures again for as long as the owner runs.

**What you need.** Jobs that wait for a worker: a sizing that learns measures only then. The memory that one worker needs, as `memoryPerWorker`.

## The steps

1. Choose the sizing:
   - `HillClimbing` when you want the most jobs a second. It keeps a worker while that worker adds at least a tenth more jobs a second.
   - `Gradient` when each job must stay fast. It keeps a worker while a job takes at most half again the time it takes with two workers.
2. Give `memoryPerWorker` to the sizing of the `PoolWorkers`. The owner never runs more workers than the computer affords: one for each CPU, while each finds its memory free.
3. Send the jobs with a `Pool`. The owner starts with two workers and takes steps for as long as it owns.

## The program

Each job uses the CPU of its helper for 30 ms. Thirty-two callers send jobs through the store for 40 seconds, and the program prints the stats of the owner every 4 seconds.

```ts title="find-the-size.ts"
import { mkdtempDisposable } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { Coprocess } from '@zukhruf/coprocess';
import {
  HillClimbing,
  IdleTimeout,
  OnDemand,
  Pool,
  PoolWorkers,
  type Worker,
  WorkerKind,
} from '@zukhruf/pool';

const helper = new WorkerKind<{ id: number }, unknown>({
  name: 'helper',
  revision: 1,
  policy: 'standard',
  retryLimit: 0,
  expireInSeconds: 60,
});

if (process.argv[2] === 'helper') {
  // A helper reads one request a line and answers it. Each job uses the CPU
  // for 30 ms, as a helper that reads text in an image does.
  for await (const line of createInterface({ input: process.stdin })) {
    const end = performance.now() + 30;
    while (performance.now() < end);
    process.stdout.write(`${JSON.stringify({ done: JSON.parse(line).id })}\n`);
  }
} else {
  // A worker runs each job on its helper.
  class HelperWorker implements Worker<{ id: number }, unknown> {
    readonly #helper = new Coprocess(
      process.execPath,
      [import.meta.filename, 'helper'],
      { name: 'helper' },
    );

    run(input: { id: number }): Promise<unknown> {
      return this.#helper.request(input);
    }

    exited(): Promise<unknown> {
      return this.#helper.exited();
    }

    kill(): void {
      this.#helper.kill();
    }

    close(): Promise<void> {
      return this.#helper.close();
    }
  }

  // A store of its own; a host of the computer gives computerStore(process.env).
  await using folder = await mkdtempDisposable(join(tmpdir(), 'pool-'));
  const store = join(folder.path, 'store.sqlite');
  const { availableMemory } = process;
  await using workers = new PoolWorkers({
    kind: helper,
    store,
    clock: globalThis,
    size: new HillClimbing({
      memoryPerWorker: 256 * 2 ** 20,
      computer: { availableParallelism, availableMemory },
    }),
    startup: new OnDemand(),
    eviction: new IdleTimeout({ after: 300_000 }),
    create: () => new HelperWorker(),
  });
  await using pool = new Pool({ kind: helper, store, clock: globalThis });

  // A backlog: 32 callers send jobs, one after the other, for 40 seconds.
  const stop = AbortSignal.timeout(40_000);
  let done = 0;
  let id = 0;
  const callers = Array.from({ length: 32 }, async () => {
    while (!stop.aborted) {
      await pool.run({ id: id++ });
      done++;
    }
  });

  const start = performance.now();
  const report = setInterval(() => {
    const seconds = Math.round((performance.now() - start) / 1000);
    const { lent, idle } = workers.stats;
    console.log(
      `${String(seconds).padStart(2)} s: ${lent} workers lent, ${idle} idle, ${done / 4} jobs a second`,
    );
    done = 0;
  }, 4_000);
  await Promise.all(callers);
  clearInterval(report);
}
```

Output on a Mac with 14 CPUs, while other programs ran (load average about 40):

```
 4 s: 3 workers lent, 0 idle, 66.25 jobs a second
 8 s: 3 workers lent, 0 idle, 73.75 jobs a second
12 s: 3 workers lent, 1 idle, 104.5 jobs a second
16 s: 4 workers lent, 1 idle, 126.5 jobs a second
20 s: 4 workers lent, 0 idle, 109 jobs a second
24 s: 4 workers lent, 0 idle, 102.75 jobs a second
28 s: 4 workers lent, 0 idle, 125.75 jobs a second
32 s: 4 workers lent, 0 idle, 105.25 jobs a second
36 s: 4 workers lent, 1 idle, 124.5 jobs a second
40 s: 6 workers lent, 0 idle, 137.75 jobs a second
```

## What the output shows

- The owner started with two workers. Each step tried one more worker, and each worker that paid stayed. The jobs a second went from 66 to 138.
- A line with one idle worker is a step with fewer workers, or the last window of a step with one more. The owner runs fewer workers for one window and keeps the other worker alive, so the step costs no warm-up.
- Each job goes through the store: a write for the send and for the settle, and a wake each way. On a computer with 4 CPUs the owner stops at 4.

## Things to know

- **A step measures three windows**: at the size the pool has, at the size it tries, and at the size it has again. A window is at least 20 jobs and 2 seconds. Thus work that changes while the pool measures, such as small images first and photos later, does not decide alone. See [ADR 0002](../adr/0002-a-sizing-that-learns-compares-one-more-worker-between-two-windows.md).
- **The pool keeps one more worker at once**, as soon as one step shows that it pays. It lets a worker go only after two steps in a row show that the worker does not pay, because a worker that closes too early must warm up again.
- **After a step that changes nothing, the pool pauses**: one window first, then twice as long after each such step, up to 16 windows. The length is random, so pools in other processes do not take their steps at the same moments. Under steady jobs, the pool starts a worker to try less and less often.
- **When other processes take the memory, the pool runs fewer workers at once.** It reads the free memory again after each window. It never runs more than the capacity when you built it.
- **No backlog, no step.** While no job waits, the pool keeps its size. To close workers that stay idle, choose an eviction such as `IdleTimeout` (see [Hold workers only while there is work](./hold-workers-only-while-there-is-work.md)).
- **One owner sizes the computer.** Every process that sends jobs of the kind to the store shares the owner's workers, so the sizing measures all of their jobs, and one more worker pays or not for the whole computer ([ADR 0016](../adr/0016-the-owners-sizing-caps-the-jobs-of-its-computer.md)).
- **The design follows production systems**: the .NET thread pool, Netflix concurrency-limits, Envoy, Akka and the Kubernetes HPA. See [ADR 0007](../adr/0007-a-sizing-that-learns-keeps-learning-in-steps-both-ways-and-pauses-between-steps-that-change-nothing.md) for what each one does.
