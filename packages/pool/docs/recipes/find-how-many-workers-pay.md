# Recipe: Let the pool find how many workers pay

**Use case.** A helper reads the text in images. You do not know how many helpers to run. The answer depends on the computer, on the images, and on the other processes that run. `Fixed(n)` is a guess. `Resources` runs one worker for each CPU, also when the jobs wait for something that the workers share. A sizing that learns measures how many workers pay, and measures again for as long as the pool runs.

**What you need.** Jobs that wait for a worker: a sizing that learns measures only then. The memory that one worker needs, as `memoryPerWorker`.

## The steps

1. Choose the sizing:
   - `HillClimbing` when you want the most jobs a second. It keeps a worker while that worker adds at least a tenth more jobs a second.
   - `Gradient` when each job must stay fast. It keeps a worker while a job takes at most half again the time it takes with two workers.
2. Give `memoryPerWorker`. The pool never runs more workers than the computer affords: one for each CPU, while each finds its memory free.
3. Send the jobs. The pool starts with two workers and takes steps for as long as it runs.

## The program

Each job uses the CPU of its helper for 30 ms. Thirty-two callers send jobs for 40 seconds, and the program prints the stats every 4 seconds.

```ts title="find-the-size.ts"
import { createInterface } from 'node:readline';

import { Coprocess } from '@zukhruf/coprocess';
import { HillClimbing, IdleTimeout, OnDemand, Pool } from '@zukhruf/pool';

if (process.argv[2] === 'helper') {
  // A helper reads one request a line and answers it. Each job uses the CPU
  // for 30 ms, as a helper that reads text in an image does.
  for await (const line of createInterface({ input: process.stdin })) {
    const end = performance.now() + 30;
    while (performance.now() < end);
    process.stdout.write(`${JSON.stringify({ done: JSON.parse(line).id })}\n`);
  }
} else {
  await using pool = new Pool({
    size: new HillClimbing({ memoryPerWorker: 256 * 2 ** 20 }),
    startup: new OnDemand(),
    eviction: new IdleTimeout({ after: 300_000 }),
    clock: globalThis,
    create: () =>
      new Coprocess(process.execPath, [import.meta.filename, 'helper'], {
        name: 'helper',
      }),
  });

  // A backlog: 32 callers send jobs, one after the other, for 40 seconds.
  const stop = AbortSignal.timeout(40_000);
  let done = 0;
  let id = 0;
  const callers = Array.from({ length: 32 }, async () => {
    while (!stop.aborted) {
      await pool.use((helper) => helper.request({ id: id++ }));
      done++;
    }
  });

  const start = performance.now();
  const report = setInterval(() => {
    const seconds = Math.round((performance.now() - start) / 1000);
    const { lent, idle } = pool.stats;
    console.log(
      `${String(seconds).padStart(2)} s: ${lent} workers lent, ${idle} idle, ${done / 4} jobs a second`,
    );
    done = 0;
  }, 4_000);
  await Promise.all(callers);
  clearInterval(report);
}
```

Output on a Mac with 14 CPUs, while other programs also ran:

```
 4 s: 3 workers lent, 0 idle, 76 jobs a second
 8 s: 3 workers lent, 0 idle, 78.75 jobs a second
12 s: 3 workers lent, 1 idle, 101.75 jobs a second
16 s: 5 workers lent, 0 idle, 131.25 jobs a second
20 s: 5 workers lent, 0 idle, 138 jobs a second
24 s: 5 workers lent, 1 idle, 167 jobs a second
28 s: 7 workers lent, 0 idle, 189 jobs a second
32 s: 6 workers lent, 0 idle, 188.5 jobs a second
36 s: 5 workers lent, 1 idle, 173 jobs a second
40 s: 6 workers lent, 0 idle, 170.75 jobs a second
```

## What the output shows

- The pool started with two workers. Each step tried one more worker, and each worker that paid stayed. The jobs a second went from 76 to 189.
- A line with one idle worker is a step with fewer workers, or the last window of a step with one more. The pool runs fewer workers for one window and keeps the other worker alive, so the step costs no warm-up.
- After 28 s, the size goes up and down by one: one more worker did not add a tenth more jobs a second on this run. On a computer with 4 CPUs the pool stops at 4.

## Things to know

- **A step measures three windows**: at the size the pool has, at the size it tries, and at the size it has again. A window is at least 20 jobs and 2 seconds. Thus work that changes while the pool measures, such as small images first and photos later, does not decide alone. See [ADR 0002](../adr/0002-a-sizing-that-learns-compares-one-more-worker-between-two-windows.md).
- **The pool keeps one more worker at once**, as soon as one step shows that it pays. It lets a worker go only after two steps in a row show that the worker does not pay, because a worker that closes too early must warm up again.
- **After a step that changes nothing, the pool pauses**: one window first, then twice as long after each such step, up to 16 windows. The length is random, so pools in other processes do not take their steps at the same moments. Under steady jobs, the pool starts a worker to try less and less often.
- **When other processes take the memory, the pool runs fewer workers at once.** It reads the free memory again after each window. It never runs more than the capacity when you built it.
- **No backlog, no step.** While no job waits, the pool keeps its size. To close workers that stay idle, choose an eviction such as `IdleTimeout` (see [Hold workers only while there is work](./hold-workers-only-while-there-is-work.md)).
- **Each pool sees only its own jobs.** Pools in several processes on one computer learn one by one. A limit for the whole computer needs one queue that all processes share.
- **The design follows production systems**: the .NET thread pool, Netflix concurrency-limits, Envoy, Akka and the Kubernetes HPA. See [ADR 0007](../adr/0007-a-sizing-that-learns-keeps-learning-in-steps-both-ways-and-pauses-between-steps-that-change-nothing.md) for what each one does.
